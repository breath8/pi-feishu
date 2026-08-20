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

async function testUpdateCard(messageId: string): Promise<void> {
  console.log("\n📝 测试更新卡片消息:", messageId);
  
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

async function main(): Promise<void> {
  console.log("🚀 飞书卡片更新测试");
  console.log("=".repeat(50));
  
  initClient();
  
  const messageId = process.argv[2];
  if (!messageId) {
    console.log("❌ 请提供消息 ID 参数");
    console.log("用法: npx tsx test-card-update.ts <message_id>");
    return;
  }
  
  await testUpdateCard(messageId);
  
  console.log("\n" + "=".repeat(50));
  console.log("✅ 测试完成");
}

main().catch(console.error);
