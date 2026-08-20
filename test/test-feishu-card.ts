import * as Lark from "@larksuiteoapi/node-sdk";
import { loadTestConfig } from "./config.js";

const FEISHU_CONFIG = loadTestConfig();
let TEST_CHAT_ID = FEISHU_CONFIG.chatId;


let client: Lark.Client;
let wsClient: Lark.WSClient;



function initClient(): void {
  const domain = FEISHU_CONFIG.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
  
  client = new Lark.Client({
    appId: FEISHU_CONFIG.appId,
    appSecret: FEISHU_CONFIG.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain,
  });

  console.log("✅ 飞书客户端初始化完成");
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

function buildTextCard(text: string): Record<string, unknown> {
  return buildCard([
    { tag: "markdown", content: safeText(text) },
  ]);
}

function buildStreamingCard(text: string, status?: string): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];

  if (status) {
    elements.push({ tag: "markdown", content: `**${status}**` });
  }

  elements.push({ tag: "markdown", content: safeText(text) });

  return buildCard(elements);
}

function buildFinalCard(text: string): Record<string, unknown> {
  return buildCard([
    { tag: "markdown", content: safeText(text) },
  ]);
}




async function testSendTextCard(): Promise<void> {
  if (!TEST_CHAT_ID) {
    console.log("⚠️  跳过测试：TEST_CHAT_ID 未设置");
    return;
  }

  console.log("\n📝 测试 1: 发送简单文本卡片");
  
  const text = "Hello! 这是来自 pi-feishu 测试脚本的消息。\n\n**加粗文本**\n*斜体文本*\n`代码`";
  const card = buildTextCard(text);
  
  console.log("卡片 JSON:");
  console.log(JSON.stringify(card, null, 2));
  
  try {
    const resp = await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: TEST_CHAT_ID,
        content: JSON.stringify(card),
        msg_type: "interactive",
      },
    });
    
    console.log("✅ 文本卡片发送成功");
    console.log("消息 ID:", resp?.data?.message_id);
  } catch (err: any) {
    console.error("❌ 文本卡片发送失败:", err?.message ?? err);
    console.error("错误码:", err?.code);
    console.error("错误信息:", err?.msg);
  }
}


async function testSendStreamingCard(): Promise<string | null> {
  if (!TEST_CHAT_ID) {
    console.log("⚠️  跳过测试：TEST_CHAT_ID 未设置");
    return null;
  }

  console.log("\n📝 测试 2: 发送流式更新卡片");
  
  const text = "⏳ **Shell** ...\n⏳ **读取文件** ...";
  const status = "执行中 (2)";
  const card = buildStreamingCard(text, status);
  
  console.log("卡片 JSON:");
  console.log(JSON.stringify(card, null, 2));
  
  try {
    const resp = await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: TEST_CHAT_ID,
        content: JSON.stringify(card),
        msg_type: "interactive",
      },
    });
    
    console.log("✅ 流式更新卡片发送成功");
    console.log("消息 ID:", resp?.data?.message_id);
    
    return resp?.data?.message_id ?? null;
  } catch (err: any) {
    console.error("❌ 流式更新卡片发送失败:", err?.message ?? err);
    console.error("错误码:", err?.code);
    console.error("错误信息:", err?.msg);
    return null;
  }
}


async function testUpdateCard(messageId: string): Promise<void> {
  if (!messageId) {
    console.log("⚠️  跳过测试：messageId 未提供");
    return;
  }

  console.log("\n📝 测试 3: 更新卡片消息");
  
  const text = "✅ ~~Shell~~\n✅ ~~读取文件~~";
  const status = "工具调用";
  const card = buildStreamingCard(text, status);
  
  console.log("更新后的卡片 JSON:");
  console.log(JSON.stringify(card, null, 2));
  
  try {
    await client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
    
    console.log("✅ 卡片更新成功");
  } catch (err: any) {
    console.error("❌ 卡片更新失败:", err?.message ?? err);
    console.error("错误码:", err?.code);
    console.error("错误信息:", err?.msg);
  }
}


async function testMarkdownFormats(): Promise<void> {
  if (!TEST_CHAT_ID) {
    console.log("⚠️  跳过测试：TEST_CHAT_ID 未设置");
    return;
  }

  console.log("\n📝 测试 4: 测试不同格式的 Markdown");
  
  const testCases = [
    {
      name: "纯文本",
      text: "这是一段纯文本",
    },
    {
      name: "加粗",
      text: "**这是加粗文本**",
    },
    {
      name: "代码块",
      text: "```\nconst x = 1;\nconsole.log(x);\n```",
    },
    {
      name: "混合格式",
      text: "# 标题\n\n这是一段文本，包含 **加粗** 和 `代码`。\n\n```javascript\nconsole.log('hello');\n```",
    },
    {
      name: "特殊字符",
      text: "特殊字符：<>&\"'",
    },
    {
      name: "长文本",
      text: "A".repeat(4000),
    },
  ];
  
  for (const testCase of testCases) {
    console.log(`\n测试: ${testCase.name}`);
    console.log(`内容: ${testCase.text.substring(0, 50)}...`);
    
    const card = buildTextCard(testCase.text);
    
    try {
      const resp = await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: TEST_CHAT_ID,
          content: JSON.stringify(card),
          msg_type: "interactive",
        },
      });
      
      console.log(`✅ ${testCase.name} 发送成功`);
    } catch (err: any) {
      console.error(`❌ ${testCase.name} 发送失败:`, err?.message ?? err);
    }
  }
}



async function testWebSocketConnection(): Promise<void> {
  console.log("\n🔌 测试 WebSocket 连接");
  
  const domain = FEISHU_CONFIG.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
  
  const dispatcher = new Lark.EventDispatcher({
    encryptKey: FEISHU_CONFIG.encryptKey ?? "",
    verificationToken: FEISHU_CONFIG.verificationToken ?? "",
  });


  dispatcher.register({
    "im.message.receive_v1": (data: any) => {
      console.log("\n📩 收到消息:");
      console.log("发送者:", data?.sender?.sender_id?.open_id);
      console.log("消息 ID:", data?.message?.message_id);
      console.log("聊天 ID:", data?.message?.chat_id);
      console.log("内容:", data?.message?.content);
      
      // 自动设置 TEST_CHAT_ID
      if (data?.message?.chat_id && !TEST_CHAT_ID) {
        TEST_CHAT_ID = data.message.chat_id;
        console.log("\n🎯 自动设置 TEST_CHAT_ID:", TEST_CHAT_ID);
      }
    },
    "im.message.message_read_v1": async () => {},
    "im.message.reaction.created_v1": async () => {},
    "im.message.reaction.deleted_v1": async () => {},
    "im.chat.member.bot.added_v1": async () => {},
    "im.chat.member.bot.deleted_v1": async () => {},
    "im.chat.access_event.bot_p2p_chat_entered_v1": async () => {},
  });

  wsClient = new Lark.WSClient({
    appId: FEISHU_CONFIG.appId,
    appSecret: FEISHU_CONFIG.appSecret,
    domain,
    loggerLevel: Lark.LoggerLevel.info,
    autoReconnect: true,
    handshakeTimeoutMs: 15000,
    wsConfig: {
      pingTimeout: 30,
    },
  });

  try {
    await wsClient.start({ eventDispatcher: dispatcher });
    console.log("✅ WebSocket 连接成功");
    console.log("\n💡 请在飞书中给 Bot 发送一条消息，然后输入 chat_id 继续测试");
  } catch (err: any) {
    console.error("❌ WebSocket 连接失败:", err?.message ?? err);
  }
}



async function main(): Promise<void> {
  console.log("🚀 飞书卡片消息测试脚本");
  console.log("=" .repeat(50));
  

  initClient();
  

  await testWebSocketConnection();
  

  if (!TEST_CHAT_ID) {
    console.log("\n⏳ 等待设置 TEST_CHAT_ID...");
    console.log("请在飞书中给 Bot 发送一条消息，然后按 Enter 继续");
    

    await new Promise(resolve => setTimeout(resolve, 5000));
    
    if (!TEST_CHAT_ID) {
      console.log("❌ 未设置 TEST_CHAT_ID，无法继续测试");
      console.log("请手动设置 TEST_CHAT_ID 变量后重新运行测试");
      return;
    }
  }
  
  console.log("\n🎯 使用 TEST_CHAT_ID:", TEST_CHAT_ID);
  

  await testSendTextCard();
  const streamingCardMsgId = await testSendStreamingCard();
  if (streamingCardMsgId) {
    await testUpdateCard(streamingCardMsgId);
  }
  await testMarkdownFormats();
  
  console.log("\n" + "=".repeat(50));
  console.log("✅ 所有测试完成");
}


main().catch(console.error);
