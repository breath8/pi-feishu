import * as Lark from "@larksuiteoapi/node-sdk";
import { loadTestConfig } from "./config.js";

const FEISHU_CONFIG = loadTestConfig();
const TEST_CHAT_ID = FEISHU_CONFIG.chatId;

let client: Lark.Client;

function initClient(): void {
  const domain = FEISHU_CONFIG.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
  client = new Lark.Client({
    appId: FEISHU_CONFIG.appId,
    appSecret: FEISHU_CONFIG.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain,
  });
}

function safeText(text: string, limit = 3500): string {
  return text.length > limit ? text.substring(0, limit) + "\n..." : text;
}

function buildCard(elements: Record<string, unknown>[]): Record<string, unknown> {
  return {
    schema: "2.0",
    body: {
      elements,
    },
  };
}

function buildStreamingCard(text: string, status?: string): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];
  if (status) {
    elements.push({ tag: "markdown", content: `**${status}**` });
  }
  elements.push({ tag: "markdown", content: safeText(text) });
  return buildCard(elements);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testStreamingUpdates(chatId: string): Promise<void> {
  console.log("\n📝 测试流式更新卡片");
  console.log("=".repeat(50));
  
  console.log("\n[1/4] 发送初始卡片...");
  const initialText = "⏳ **Shell** ...";
  const initialStatus = "执行中 (1)";
  const initialCard = buildStreamingCard(initialText, initialStatus);
  
  let messageId: string | null = null;
  try {
    const resp = await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        content: JSON.stringify(initialCard),
        msg_type: "interactive",
      },
    });
    messageId = resp?.data?.message_id ?? null;
    console.log("✅ 初始卡片发送成功，消息 ID:", messageId);
  } catch (err: any) {
    console.error("❌ 初始卡片发送失败:", err?.message ?? err);
    return;
  }
  
  if (!messageId) return;
  
  await sleep(1000);
  console.log("\n[2/4] 更新卡片（添加第二个工具）...");
  const text2 = "✅ ~~Shell~~\n⏳ **读取文件** ...";
  const status2 = "执行中 (1)";
  const card2 = buildStreamingCard(text2, status2);
  
  try {
    await client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card2) },
    });
    console.log("✅ 卡片更新成功");
  } catch (err: any) {
    console.error("❌ 卡片更新失败:", err?.message ?? err);
  }
  
  await sleep(1000);
  console.log("\n[3/4] 更新卡片（完成所有工具）...");
  const text3 = "✅ ~~Shell~~\n✅ ~~读取文件~~";
  const status3 = "工具调用";
  const card3 = buildStreamingCard(text3, status3);
  
  try {
    await client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card3) },
    });
    console.log("✅ 卡片更新成功");
  } catch (err: any) {
    console.error("❌ 卡片更新失败:", err?.message ?? err);
  }
  
  await sleep(1000);
  console.log("\n[4/4] 最终状态...");
  const text4 = "✅ ~~Shell~~\n✅ ~~读取文件~~";
  const status4 = "完成";
  const card4 = buildStreamingCard(text4, status4);
  
  try {
    await client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card4) },
    });
    console.log("✅ 卡片更新成功");
  } catch (err: any) {
    console.error("❌ 卡片更新失败:", err?.message ?? err);
  }
  
  console.log("\n" + "=".repeat(50));
  console.log("✅ 流式更新测试完成");
}

async function main(): Promise<void> {
  console.log("🚀 飞书流式更新卡片测试");
  console.log("=".repeat(50));
  
  initClient();
  
  const chatId = process.argv[2];
  if (!chatId) {
    console.log("❌ 请提供 chat_id 参数");
    console.log("用法: npx tsx test-card-streaming.ts <chat_id>");
    return;
  }
  
  await testStreamingUpdates(chatId);
}

main().catch(console.error);
