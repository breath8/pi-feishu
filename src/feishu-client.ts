/**
 * feishu-client.ts — 飞书 WebSocket 客户端
 *
 * 基于 @larksuiteoapi/node-sdk 的 Client + WSClient + EventDispatcher 封装。
 * 负责：WebSocket 长连接管理、事件接收、消息发送、媒体收发、
 *        消息去重、Reaction 输入指示、交互卡片。
 *
 * 参考：openclaw-lark 项目的 lark-client.ts 和 monitor.ts
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FeishuConfig, BridgeStatus } from "./types.js";

// ─── 日志 ─────────────────────────────────────────────

const DEBUG = false;
function _log(...args: unknown[]): void {
  if (DEBUG) console.log("[FeishuClient]", ...args);
}
function _warn(...args: unknown[]): void {
  console.warn("[FeishuClient]", ...args);
}

// ─── 常量 ─────────────────────────────────────────────

/** 消息去重 TTL（12 小时） */
const DEDUP_TTL_MS = 12 * 60 * 60 * 1000;
/** 去重最大条目 */
const DEDUP_MAX_ENTRIES = 5000;
/** 去重定期清理间隔（5 分钟） */
const DEDUP_SWEEP_INTERVAL = 5 * 60 * 1000;
/** 消息过期判定（30 分钟） */
const MESSAGE_EXPIRY_MS = 30 * 60 * 60 * 1000;
/** 媒体文件临时目录 */
const MEDIA_TEMP_DIR = join(tmpdir(), "feishu-media");
/** 临时文件保留期 */
const MEDIA_TTL_MS = 24 * 60 * 60 * 1000;
/** 飞书 Reaction emoji 类型 */
const REACTION_TYPING = "Typing";
const REACTION_CROSS_MARK = "CrossMark";
/** 单条卡片/消息最大文本长度（4000 字符） */
const MAX_TEXT_CHUNK = 4000;

// ─── 飞书事件类型 ───────────────────────────────────────

/** SDK 传入的 im.message.receive_v1 事件数据结构 */
interface FeishuMessageEvent {
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time?: string;
    update_time?: string;
    chat_id: string;
    thread_id?: string;
    chat_type: "p2p" | "group";
    message_type: string;
    content: string; // JSON 字符串
    mentions?: Array<{
      key: string;
      id: { open_id?: string; user_id?: string; union_id?: string };
      name: string;
      tenant_key?: string;
    }>;
    user_agent?: string;
  };
}

// ─── 导出类型 ──────────────────────────────────────────

/** 入站消息中可能携带的资源描述 */
export interface InboundResource {
  type: "image" | "file" | "audio" | "video";
  fileKey: string;
  fileName?: string;
}

// ─── FeishuClient 类 ───────────────────────────────────

export class FeishuClient {
  private client: Lark.Client;
  private wsClient: Lark.WSClient | null = null;
  private abortController: AbortController | null = null;
  private status: BridgeStatus = "disconnected";

  // 重连
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;

  // 消息去重
  private dedupMap: Map<string, number> = new Map();
  private dedupSweepTimer: ReturnType<typeof setInterval> | null = null;

  // Bot 身份（连接后探测）
  private botOpenId: string = "";

  // 回调 — 扩展为包含资源列表
  private onMessageCallback:
    | ((
        chatId: string,
        msgId: string,
        text: string,
        chatType: "p2p" | "group",
        resources: InboundResource[],
      ) => void)
    | null = null;
  private onStatusChangeCallback: ((status: BridgeStatus) => void) | null = null;

  // Reaction 跟踪：chatId → { msgId, reactionId }
  private typingMessages: Map<string, { msgId: string; reactionId: string }> = new Map();

  constructor(private config: FeishuConfig) {
    const domain = config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;

    this.client = new Lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain,
    });

    // 确保临时目录存在
    if (!existsSync(MEDIA_TEMP_DIR)) {
      mkdirSync(MEDIA_TEMP_DIR, { recursive: true });
    }
  }

  // ─── 公开 API ───────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > 5) {
      _warn("WSClient: 重连尝试已用尽，请手动执行 /feishu start");
      return;
    }
    const delayMs = Math.min(30000, 1000 * 2 ** this.reconnectAttempts);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.status === "connected" || this.status === "connecting") return;
      _log(`WSClient: 自动重连 第${this.reconnectAttempts}次`);
      this.connect().catch(() => {});
    }, delayMs);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  /** 连接飞书 WebSocket 长连接 */
  async connect(): Promise<void> {
    if (this.status === "connected" || this.status === "connecting") {
      _log("Already connected or connecting, skip");
      return;
    }

    this.setStatus("connecting");
    _log("Connecting to Feishu WebSocket...");

    try {
      this.abortController = new AbortController();

      const dispatcher = new Lark.EventDispatcher({
        encryptKey: this.config.encryptKey ?? "",
        verificationToken: this.config.verificationToken ?? "",
      });

      dispatcher.register({
        "im.message.receive_v1": (data: any) => {
          this.handleInboundMessage(data);
        },
        "im.message.message_read_v1": async () => {},
        "im.message.reaction.created_v1": async () => {},
        "im.message.reaction.deleted_v1": async () => {},
        "im.chat.member.bot.added_v1": async () => {},
        "im.chat.member.bot.deleted_v1": async () => {},
        "im.chat.access_event.bot_p2p_chat_entered_v1": async () => {},
      });

      if (this.wsClient) {
        try {
          (this.wsClient as any).close({ force: true });
        } catch { /* ignore */ }
      }

      const domain = this.config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
      this.wsClient = new Lark.WSClient({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        domain,
        loggerLevel: Lark.LoggerLevel.info,
        autoReconnect: true,
        handshakeTimeoutMs: 15000,
        wsConfig: {
          pingTimeout: 30,
        },
        onReady: () => {
          _log("WSClient: first connection established");
          this.setStatus("connected");
        },
        onReconnecting: () => {
          _warn("WSClient: connection lost, reconnecting...");
          this.setStatus("connecting");
        },
        onReconnected: () => {
          _log("WSClient: reconnected successfully");
          this.setStatus("connected");
        },
        onError: (err: Error) => {
          _warn("WSClient: terminal error:", err.message);
          this.setStatus("error");
          this.scheduleReconnect();
        },
      });

      this.patchCardEvents();
      this.startDedupSweep();
      this.cleanMediaTempDir();

      await this.wsClient.start({ eventDispatcher: dispatcher });

      // start() 仅发起连接不等待握手；就绪由 onReady/onReconnected 置位
      this.reconnectAttempts = 0;
      _log("Feishu WebSocket connected");
    } catch (err) {
      _warn("Connect failed:", err);
      this.setStatus("error");
      throw err;
    }
  }

  /** 断开连接 */
  disconnect(): void {
    _log("Disconnecting...");
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.reconnectAttempts = 0;

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.wsClient) {
      try {
        (this.wsClient as any).close({ force: true });
      } catch { /* ignore */ }
      this.wsClient = null;
    }

    if (this.dedupSweepTimer) {
      clearInterval(this.dedupSweepTimer);
      this.dedupSweepTimer = null;
    }

    // 清除所有 typing reactions
    for (const [chatId, entry] of this.typingMessages) {
      this.removeReactionById(entry.msgId, entry.reactionId).catch(() => {});
    }
    this.typingMessages.clear();

    this.setStatus("disconnected");
  }

  getStatus(): BridgeStatus {
    return this.status;
  }

  // ─── 消息发送 ──────────────────────────────────────────

  /** 发送文本消息到飞书（回复模式优先，自动分段，使用 interactive 卡片格式，保证严格按序发送） */
  async sendMessage(chatId: string, text: string, replyToMsgId?: string): Promise<void> {
    const chunks = FeishuClient.chunkText(text, MAX_TEXT_CHUNK);
    const allCards: Record<string, unknown>[] = [];
    for (const chunk of chunks) {
      const cards = FeishuClient.buildTextCardsWithTable(chunk);
      allCards.push(...cards);
    }

    for (let i = 0; i < allCards.length; i++) {
      const card = allCards[i];
      const isFirst = i === 0;
      const content = JSON.stringify(card);

      try {
        if (isFirst && replyToMsgId) {
          await this.client.im.message.reply({
            path: { message_id: replyToMsgId },
            data: { content, msg_type: "interactive" },
          });
        } else {
          await this.client.im.message.create({
            params: { receive_id_type: "chat_id" },
            data: { receive_id: chatId, content, msg_type: "interactive" },
          });
        }
      } catch (err: any) {
        if (isFirst && replyToMsgId && (err?.code === 230011 || err?.code === 231003)) {
          _warn("Reply failed (message withdrawn), falling back to create");
          await this.client.im.message.create({
            params: { receive_id_type: "chat_id" },
            data: { receive_id: chatId, content, msg_type: "interactive" },
          });
        } else {
          throw err;
        }
      }

      if (i < allCards.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    _log(`Message sent to ${chatId}${replyToMsgId ? ` (reply to ${replyToMsgId})` : ""} (${allCards.length} cards)`);
  }

  /** 发送交互卡片消息 */
  async sendCard(
    chatId: string,
    card: Record<string, unknown>,
    replyToMsgId?: string,
  ): Promise<string | null> {
    const content = JSON.stringify(card);

    try {
      if (replyToMsgId) {
        const resp = await this.client.im.message.reply({
          path: { message_id: replyToMsgId },
          data: { content, msg_type: "interactive" },
        });
        return resp?.data?.message_id ?? null;
      } else {
        const resp = await this.client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: { receive_id: chatId, content, msg_type: "interactive" },
        });
        return resp?.data?.message_id ?? null;
      }
    } catch (err: any) {
      _warn("Send card failed:", err?.message ?? err);
      return null;
    }
  }

  /** 更新（PATCH）已有的卡片消息 */
  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    await this.client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
  }

  // ─── 媒体收发 ──────────────────────────────────────────

  private cleanMediaTempDir(): void {
    try {
      if (!existsSync(MEDIA_TEMP_DIR)) return;
      const cutoff = Date.now() - MEDIA_TTL_MS;
      for (const name of readdirSync(MEDIA_TEMP_DIR)) {
        const p = join(MEDIA_TEMP_DIR, name);
        try {
          if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  /** 下载消息中的资源（图片/文件）到本地临时目录 */
  async downloadResource(
    messageId: string,
    fileKey: string,
    resourceType: string,
    fileName?: string,
  ): Promise<string | null> {
    try {
      _log(`Downloading resource: ${fileKey} from message ${messageId}`);

      const resp = await this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: resourceType as any },
      });

      if (!resp) return null;

      // SDK 返回 { writeFile, getReadableStream, headers }
      // 生成文件名
      const ext = resourceType === "image" ? ".png" : resourceType === "audio" ? ".ogg" : "";
      const safeName = (fileName && fileName.length > 0)
        ? fileName.replace(/[^a-zA-Z0-9._-]/g, "_")
        : `${fileKey}${ext}`;
      const localPath = join(MEDIA_TEMP_DIR, `${Date.now()}-${safeName}`);

      // 优先使用 writeFile()（SDK 原生写入磁盘）
      if (typeof resp.writeFile === "function") {
        await resp.writeFile(localPath);
        _log(`Resource downloaded via writeFile to ${localPath}`);
        return localPath;
      }

      // 回退：使用 getReadableStream() 手动收集
      if (typeof resp.getReadableStream === "function") {
        const stream = resp.getReadableStream();
        const chunks: Buffer[] = [];
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          chunks.push(Buffer.from(chunk));
        }
        const buffer = Buffer.concat(chunks);
        writeFileSync(localPath, buffer);
        _log(`Resource downloaded via stream to ${localPath} (${buffer.length} bytes)`);
        return localPath;
      }

      _warn("No writeFile or getReadableStream on response");
      return null;
    } catch (err) {
      _warn("Download resource failed:", err);
      return null;
    }
  }

  /** 上传图片到飞书，返回 image_key */
  async uploadImage(filePath: string): Promise<string | null> {
    try {
      const { createReadStream } = await import("node:fs");
      const stream = createReadStream(filePath);

      const resp = await this.client.im.image.create({
        data: {
          image_type: "message" as any,
          image: stream as any,
        },
      });

      // SDK 返回 { image_key } | null，image_key 在顶层
      const imageKey = resp?.image_key ?? null;
      _log(`Image uploaded: ${imageKey}`);
      return imageKey;
    } catch (err) {
      _warn("Upload image failed:", err);
      return null;
    }
  }

  /** 上传文件到飞书，返回 file_key */
  async uploadFile(filePath: string, fileName: string, fileType: string = "stream"): Promise<string | null> {
    try {
      const { createReadStream } = await import("node:fs");
      const stream = createReadStream(filePath);

      const resp = await this.client.im.file.create({
        data: {
          file_type: fileType as any,
          file_name: fileName,
          file: stream as any,
        },
      });

      // SDK 返回 { file_key } | null，file_key 在顶层
      const fileKey = resp?.file_key ?? null;
      _log(`File uploaded: ${fileKey}`);
      return fileKey;
    } catch (err) {
      _warn("Upload file failed:", err);
      return null;
    }
  }

  /** 发送图片消息（通过 image_key） */
  async sendImage(chatId: string, imageKey: string, replyToMsgId?: string): Promise<void> {
    const content = JSON.stringify({ image_key: imageKey });

    if (replyToMsgId) {
      await this.client.im.message.reply({
        path: { message_id: replyToMsgId },
        data: { content, msg_type: "image" },
      });
    } else {
      await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, content, msg_type: "image" },
      });
    }
  }

  /** 发送文件消息（通过 file_key） */
  async sendFile(chatId: string, fileKey: string, replyToMsgId?: string): Promise<void> {
    const content = JSON.stringify({ file_key: fileKey });

    if (replyToMsgId) {
      await this.client.im.message.reply({
        path: { message_id: replyToMsgId },
        data: { content, msg_type: "file" },
      });
    } else {
      await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, content, msg_type: "file" },
      });
    }
  }

  // ─── Reaction 输入指示 ─────────────────────────────────

  /** 添加 typing 指示（开始处理消息时调用） */
  async startTyping(chatId: string, msgId: string): Promise<void> {
    const reactionId = await this.addReaction(msgId, REACTION_TYPING);
    if (reactionId) {
      this.typingMessages.set(chatId, { msgId, reactionId });
    }
  }

  /** 停止 typing 指示（处理完成时调用） */
  async stopTyping(chatId: string, success: boolean = true): Promise<void> {
    const entry = this.typingMessages.get(chatId);
    if (!entry) return;

    this.typingMessages.delete(chatId);

    // 移除 Typing reaction（用真实的 reaction_id）
    await this.removeReactionById(entry.msgId, entry.reactionId).catch(() => {});

    // 失败时添加 CrossMark
    if (!success) {
      await this.addReaction(entry.msgId, REACTION_CROSS_MARK).catch(() => {});
    }
  }

  // ─── 回调注册 ──────────────────────────────────────────

  setOnMessage(
    cb: (
      chatId: string,
      msgId: string,
      text: string,
      chatType: "p2p" | "group",
      resources: InboundResource[],
    ) => void,
  ): void {
    this.onMessageCallback = cb;
  }

  setOnStatusChange(cb: (status: BridgeStatus) => void): void {
    this.onStatusChangeCallback = cb;
  }

  // ─── 内部方法 ───────────────────────────────────────

  private setStatus(status: BridgeStatus): void {
    this.status = status;
    this.onStatusChangeCallback?.(status);
  }

  /** 处理入站消息事件 */
  private handleInboundMessage(data: FeishuMessageEvent): void {
    try {
      const msg = data.message;
      const sender = data.sender;

      if (msg.create_time && this.isMessageExpired(msg.create_time)) return;
      if (!this.tryRecordDedup(msg.message_id)) return;

      const senderType = sender.sender_type;
      if (senderType === "bot" || senderType === "app") return;

      const chatId = msg.chat_id;
      const chatType = msg.chat_type;
      const messageId = msg.message_id;

      // 解析消息内容和资源
      const { text, resources } = this.parseContentWithResources(msg.content, msg.message_type, msg.mentions);

      if (!text && resources.length === 0) return;

      _log(
        `Inbound: chatId=${chatId}, type=${chatType}, msgId=${messageId}, ` +
        `text=${(text ?? "").substring(0, 50)}..., resources=${resources.length}`,
      );

      this.onMessageCallback?.(chatId, messageId, text ?? "", chatType, resources);
    } catch (err) {
      _warn("Error handling inbound message:", err);
    }
  }

  // ─── 内容解析 ─────────────────────────────────────────

  /**
   * 解析消息内容和资源列表。
   * 媒体类型的消息会返回占位文本 + 资源描述，由 index.ts 决定是否下载。
   */
  private parseContentWithResources(
    rawContent: string,
    messageType: string,
    mentions?: FeishuMessageEvent["message"]["mentions"],
  ): { text: string; resources: InboundResource[] } {
    let parsed: any;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      return { text: rawContent, resources: [] };
    }

    let text = "";
    const resources: InboundResource[] = [];

    switch (messageType) {
      case "text":
        text = parsed?.text ?? "";
        break;

      case "post": {
        const parts: string[] = [];
        const locale = parsed?.zh_cn ?? parsed?.en_us ?? parsed?.ja_jp;
        if (locale?.title) parts.push(locale.title);
        if (Array.isArray(locale?.content)) {
          for (const row of locale.content) {
            if (Array.isArray(row)) {
              for (const elem of row) {
                if (elem?.tag === "text" && elem.text) parts.push(elem.text);
                else if (elem?.tag === "a" && elem.text) parts.push(elem.text);
                else if (elem?.tag === "md" && elem.text) parts.push(elem.text);
                else if (elem?.tag === "at") parts.push(elem.user_id ?? "");
                else if (elem?.tag === "img") {
                  parts.push(`[图片]`);
                  if (elem.image_key) {
                    resources.push({ type: "image", fileKey: elem.image_key });
                  }
                }
              }
            }
          }
        }
        text = parts.join("");
        break;
      }

      case "image":
        text = "[图片]";
        if (parsed?.image_key) {
          resources.push({ type: "image", fileKey: parsed.image_key });
        }
        break;

      case "file":
        text = `[文件: ${parsed?.file_name ?? "unknown"}]`;
        if (parsed?.file_key) {
          resources.push({
            type: "file",
            fileKey: parsed.file_key,
            fileName: parsed?.file_name,
          });
        }
        break;

      case "audio":
        text = "[语音消息]";
        if (parsed?.file_key) {
          resources.push({ type: "audio", fileKey: parsed.file_key });
        }
        break;

      case "video":
        text = "[视频]";
        if (parsed?.file_key) {
          resources.push({ type: "video", fileKey: parsed.file_key, fileName: parsed?.file_name });
        }
        break;

      case "sticker":
        text = "[表情]";
        break;

      case "interactive":
        text = "[卡片消息]";
        break;

      case "share_chat":
        text = "[群分享]";
        break;

      case "merge_forward":
        text = "[合并转发消息]";
        break;

      default:
        text = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    }

    // 移除 @Bot mention 占位符
    if (mentions && text) {
      text = this.stripMentionPlaceholders(text, mentions);
    }

    return { text: text.trim(), resources };
  }

  /** 移除消息中的 mention 占位符 */
  private stripMentionPlaceholders(
    text: string,
    mentions: FeishuMessageEvent["message"]["mentions"],
  ): string {
    let result = text;
    for (const m of mentions ?? []) {
      if (this.botOpenId && m.id.open_id === this.botOpenId) {
        result = result.replace(new RegExp(escapeRegExp(m.key) + "\\s*", "g"), "");
      }
    }
    return result;
  }

  // ─── 交互卡片构建 ──────────────────────────────────────

  /** 截断过长文本 */
  private static safeText(text: string, limit = 3500): string {
    return text.length > limit ? text.substring(0, limit) + "\n..." : text;
  }

  /**
   * 构建飞书交互卡片（v1 格式）。
   *
   * 注意：飞书 Bot 消息 API (im.message.create) 的 interactive 类型
   * 期望 v1 卡片格式（elements 在顶层 + config.wide_screen_mode），
   * 而不是 v2 格式（schema: "2.0" + body 包装层）。
   * 使用 v2 格式会导致卡片渲染为空白。
   */
  private static buildCard(elements: Record<string, unknown>[]): Record<string, unknown> {
    return {
      schema: "2.0",
      body: {
        elements,
      },
    };
  }

  /** 构建纯文本卡片（用于普通消息回复，支持完整 Markdown） */
  static buildTextCard(text: string): Record<string, unknown> {
    return FeishuClient.buildCard([
      { tag: "markdown", content: text },
    ]);
  }

  static chunkText(text: string, maxLen: number = MAX_TEXT_CHUNK): string[] {
    if (text.length <= maxLen) return [text];

    type BlockType = "paragraph" | "code_block" | "table";
    interface ContentBlock {
      type: BlockType;
      content: string;
      fence?: string;
    }

    const lines = text.split("\n");
    const blocks: ContentBlock[] = [];

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
      if (fenceMatch) {
        const fenceChar = fenceMatch[2][0];
        const fenceLen = fenceMatch[2].length;
        const codeLines = [line];
        i++;
        while (i < lines.length) {
          const cur = lines[i];
          codeLines.push(cur);
          const closeMatch = cur.match(/^(\s*)(`{3,}|~{3,})\s*$/);
          if (closeMatch && closeMatch[2][0] === fenceChar && closeMatch[2].length >= fenceLen) {
            i++;
            break;
          }
          i++;
        }
        blocks.push({
          type: "code_block",
          content: codeLines.join("\n"),
          fence: fenceMatch[2] + fenceMatch[3],
        });
        continue;
      }

      const isTableLine = line.includes("|") && line.trim().startsWith("|");
      if (isTableLine) {
        const tableLines = [line];
        i++;
        while (i < lines.length) {
          const cur = lines[i];
          if (cur.includes("|") && cur.trim().startsWith("|")) {
            tableLines.push(cur);
            i++;
          } else {
            break;
          }
        }
        blocks.push({
          type: "table",
          content: tableLines.join("\n"),
        });
        continue;
      }

      const paraLines = [line];
      i++;
      while (i < lines.length) {
        const cur = lines[i];
        const isFence = /^(\s*)(`{3,}|~{3,})(.*)$/.test(cur);
        const isTbl = cur.includes("|") && cur.trim().startsWith("|");
        if (isFence || isTbl) {
          break;
        }
        paraLines.push(cur);
        i++;
      }
      blocks.push({
        type: "paragraph",
        content: paraLines.join("\n"),
      });
    }

    const chunks: string[] = [];
    let currentChunkParts: string[] = [];
    let currentChunkLen = 0;

    const flushCurrentChunk = () => {
      if (currentChunkParts.length > 0) {
        chunks.push(currentChunkParts.join("\n\n"));
        currentChunkParts = [];
        currentChunkLen = 0;
      }
    };

    for (const block of blocks) {
      const blockLen = block.content.length + (currentChunkParts.length > 0 ? 2 : 0);

      if (currentChunkLen + blockLen <= maxLen) {
        currentChunkParts.push(block.content);
        currentChunkLen += blockLen;
        continue;
      }

      if (currentChunkParts.length > 0) {
        flushCurrentChunk();
      }

      if (block.content.length <= maxLen) {
        currentChunkParts.push(block.content);
        currentChunkLen = block.content.length;
        continue;
      }

      if (block.type === "code_block") {
        const bLines = block.content.split("\n");
        const openFence = bLines[0];
        const closeFence = bLines.length > 1 && /^(\s*)(`{3,}|~{3,})\s*$/.test(bLines[bLines.length - 1])
          ? bLines[bLines.length - 1]
          : "```";
        const innerLines = bLines.slice(1, bLines.length - 1);

        let subLines: string[] = [];
        let subLen = openFence.length + 1 + closeFence.length;

        for (const codeLine of innerLines) {
          const lLen = codeLine.length + 1;
          if (subLen + lLen > maxLen && subLines.length > 0) {
            chunks.push([openFence, ...subLines, closeFence].join("\n"));
            subLines = [];
            subLen = openFence.length + 1 + closeFence.length;
          }
          subLines.push(codeLine);
          subLen += lLen;
        }

        if (subLines.length > 0) {
          chunks.push([openFence, ...subLines, closeFence].join("\n"));
        }
      } else if (block.type === "table") {
        const tLines = block.content.split("\n");
        const headerLines = tLines.slice(0, 2);
        const headerStr = headerLines.join("\n");
        const dataLines = tLines.slice(2);

        let subTableRows: string[] = [];
        let subTableLen = headerStr.length + 1;

        for (const dLine of dataLines) {
          const lLen = dLine.length + 1;
          if (subTableLen + lLen > maxLen && subTableRows.length > 0) {
            chunks.push([headerStr, ...subTableRows].join("\n"));
            subTableRows = [];
            subTableLen = headerStr.length + 1;
          }
          subTableRows.push(dLine);
          subTableLen += lLen;
        }

        if (subTableRows.length > 0) {
          chunks.push([headerStr, ...subTableRows].join("\n"));
        }
      } else {
        const pLines = block.content.split("\n");
        let subParaLines: string[] = [];
        let subParaLen = 0;

        for (const pl of pLines) {
          const lLen = pl.length + 1;
          if (subParaLen + lLen > maxLen && subParaLines.length > 0) {
            chunks.push(subParaLines.join("\n"));
            subParaLines = [];
            subParaLen = 0;
          }
          subParaLines.push(pl);
          subParaLen += lLen;
        }

        if (subParaLines.length > 0) {
          currentChunkParts.push(subParaLines.join("\n"));
          currentChunkLen = subParaLines.join("\n").length;
        }
      }
    }

    flushCurrentChunk();
    return chunks;
  }

  static buildTextCardsWithTable(text: string): Record<string, unknown>[] {
    const hasTable = FeishuClient.detectMarkdownTable(text);
    
    if (!hasTable) {
      return [FeishuClient.buildTextCard(text)];
    }

    const MAX_TABLES_PER_CARD = 5;
    const parts = FeishuClient.splitTextAndTables(text);
    const cards: Record<string, unknown>[] = [];
    let currentElements: Record<string, unknown>[] = [];
    let tableCount = 0;

    for (const part of parts) {
      if (part.type === "text" && part.content.trim()) {
        currentElements.push({ tag: "markdown", content: part.content.trim() });
      } else if (part.type === "table") {
        if (tableCount >= MAX_TABLES_PER_CARD) {
          if (currentElements.length > 0) {
            cards.push(FeishuClient.buildCard(currentElements));
          }
          currentElements = [];
          tableCount = 0;
        }
        const table = FeishuClient.buildFeishuTable(part.content);
        if (table) {
          currentElements.push(table);
          tableCount++;
        } else {
          currentElements.push({ tag: "markdown", content: part.content });
        }
      }
    }

    if (currentElements.length > 0) {
      cards.push(FeishuClient.buildCard(currentElements));
    }

    if (cards.length === 0) {
      cards.push(FeishuClient.buildCard([{ tag: "markdown", content: "处理中..." }]));
    }

    return cards;
  }

  private static detectMarkdownTable(text: string): boolean {
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.includes("|") && line.trim().startsWith("|")) {
        const cells = line.split("|").filter(c => c.trim() !== "");
        if (cells.length >= 2) {
          return true;
        }
      }
    }
    return false;
  }

  private static splitTextAndTables(text: string): Array<{ type: "text" | "table"; content: string }> {
    const parts: Array<{ type: "text" | "table"; content: string }> = [];
    const lines = text.split("\n");
    let currentText: string[] = [];
    let tableLines: string[] = [];
    let inTable = false;

    for (const line of lines) {
      const isTableLine = line.includes("|") && line.trim().startsWith("|");

      if (isTableLine) {
        if (!inTable) {
          if (currentText.length > 0) {
            parts.push({ type: "text", content: currentText.join("\n") });
            currentText = [];
          }
          inTable = true;
        }
        tableLines.push(line);
      } else {
        if (inTable) {
          if (tableLines.length > 0) {
            parts.push({ type: "table", content: tableLines.join("\n") });
            tableLines = [];
          }
          inTable = false;
        }
        currentText.push(line);
      }
    }

    if (inTable && tableLines.length > 0) {
      parts.push({ type: "table", content: tableLines.join("\n") });
    } else if (currentText.length > 0) {
      parts.push({ type: "text", content: currentText.join("\n") });
    }

    return parts;
  }

  private static buildFeishuTable(text: string): Record<string, unknown> | null {
    const table = FeishuClient.parseMarkdownTable(text);
    if (!table) return null;

    const columns = table.headers.map((header, index) => ({
      name: `col_${index}`,
      display_name: header,
      data_type: "text" as const,
    }));

    const cleanCellText = (text: string): string => {
      return text
        .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/\*(.+?)\*/g, "$1")
        .replace(/`(.+?)`/g, "$1")
        .replace(/\[(.+?)\]\(.+?\)/g, "$1")
        .trim();
    };

    const rows = table.rows.map(row => {
      const rowData: Record<string, string> = {};
      table.headers.forEach((_, index) => {
        rowData[`col_${index}`] = cleanCellText(row[index] || "");
      });
      return rowData;
    });

    return {
      tag: "table",
      page_size: Math.min(rows.length, 10),
      columns,
      rows,
    };
  }

  private static parseMarkdownTable(text: string): { headers: string[]; rows: string[][] } | null {
    const lines = text.split("\n");
    const headers: string[] = [];
    const rows: string[][] = [];
    let headerFound = false;
    let separatorFound = false;

    for (const line of lines) {
      if (!line.includes("|") || !line.trim().startsWith("|")) {
        if (headerFound && separatorFound) {
          break;
        }
        continue;
      }

      const cells = line.split("|").filter(c => c.trim() !== "").map(c => c.trim());

      if (!headerFound) {
        headers.push(...cells);
        headerFound = true;
      } else if (!separatorFound && cells.every(c => c.match(/^[-:]+$/))) {
        separatorFound = true;
      } else if (headerFound && separatorFound) {
        rows.push(cells);
      }
    }

    if (headers.length === 0 || rows.length === 0) {
      return null;
    }

    return { headers, rows };
  }

  static buildStreamingCard(text: string, status?: string): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [];

    if (status) {
      elements.push({ tag: "markdown", content: `**${status}**` });
    }

    elements.push({ tag: "markdown", content: FeishuClient.safeText(text) });

    return FeishuClient.buildCard(elements);
  }

  /** 构建完成态卡片（支持完整 Markdown） */
  static buildFinalCard(text: string): Record<string, unknown> {
    return FeishuClient.buildCard([
      { tag: "markdown", content: FeishuClient.safeText(text) },
    ]);
  }

  // ─── Reaction ──────────────────────────────────────────

  /** 添加 Reaction，返回 reaction_id（用于后续删除） */
  private async addReaction(msgId: string, emojiType: string): Promise<string | null> {
    try {
      const resp = await this.client.im.messageReaction.create({
        path: { message_id: msgId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      const reactionId = resp?.data?.reaction_id ?? null;
      _log(`Reaction added: ${emojiType} → ${reactionId}`);
      return reactionId;
    } catch (err) {
      _log("Add reaction failed:", emojiType, err);
      return null;
    }
  }

  /** 通过真实的 reaction_id 删除 Reaction */
  private async removeReactionById(msgId: string, reactionId: string): Promise<void> {
    try {
      await this.client.im.messageReaction.delete({
        path: { message_id: msgId, reaction_id: reactionId },
      });
    } catch (err) {
      _log("Remove reaction failed:", reactionId, err);
    }
  }

  // ─── Card Event Patch ─────────────────────────────────

  private patchCardEvents(): void {
    if (!this.wsClient) return;
    const wsClientAny = this.wsClient as any;
    const origHandleEventData = wsClientAny.handleEventData?.bind(wsClientAny);
    if (!origHandleEventData) {
      _warn("patchCardEvents: SDK handleEventData 不存在，卡片回调将失效（SDK 版本变更？）");
      return;
    }

    wsClientAny.handleEventData = (data: any) => {
      const msgType = data?.headers?.find?.((h: any) => h?.key === "type")?.value;
      if (msgType === "card") {
        const patchedData = {
          ...data,
          headers: data.headers.map((h: any) =>
            h.key === "type" ? { ...h, value: "event" } : h,
          ),
        };
        return origHandleEventData(patchedData);
      }
      return origHandleEventData(data);
    };
  }

  // ─── 去重 ───────────────────────────────────────────

  private tryRecordDedup(msgId: string): boolean {
    const now = Date.now();
    const existing = this.dedupMap.get(msgId);
    if (existing !== undefined) {
      if (now - existing < DEDUP_TTL_MS) return false;
      this.dedupMap.delete(msgId);
    }

    if (this.dedupMap.size >= DEDUP_MAX_ENTRIES) {
      const firstKey = this.dedupMap.keys().next().value;
      if (firstKey !== undefined) this.dedupMap.delete(firstKey);
    }

    this.dedupMap.set(msgId, now);
    return true;
  }

  private startDedupSweep(): void {
    if (this.dedupSweepTimer) clearInterval(this.dedupSweepTimer);
    this.dedupSweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, ts] of this.dedupMap) {
        if (now - ts >= DEDUP_TTL_MS) {
          this.dedupMap.delete(key);
        } else {
          break;
        }
      }
    }, DEDUP_SWEEP_INTERVAL);
    if (this.dedupSweepTimer.unref) this.dedupSweepTimer.unref();
  }

  private isMessageExpired(createTimeStr: string): boolean {
    const createTime = parseInt(createTimeStr, 10);
    if (isNaN(createTime)) return false;
    return Date.now() - createTime > MESSAGE_EXPIRY_MS;
  }
}

// ─── 工具函数 ─────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
