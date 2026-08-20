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

function buildTextCard(text: string): Record<string, unknown> {
  return buildCard([
    { tag: "markdown", content: safeText(text) },
  ]);
}

async function testMarkdownFormats(chatId: string): Promise<void> {
  console.log("\n📝 测试不同Markdown格式");
  console.log("=".repeat(50));
  
  const testCases = [
    { name: "纯文本", text: "这是一段纯文本" },
    { name: "加粗", text: "**这是加粗文本**" },
    { name: "斜体", text: "*这是斜体文本*" },
    { name: "代码", text: "`这是代码`" },
    { name: "代码块", text: "```\nconst x = 1;\nconsole.log(x);\n```" },
    { name: "链接", text: "[这是链接](https://example.com)" },
    { name: "列表", text: "- 项目1\n- 项目2\n- 项目3" },
    { name: "有序列表", text: "1. 第一项\n2. 第二项\n3. 第三项" },
    { name: "引用", text: "> 这是引用文本" },
    { name: "分割线", text: "---" },
    { name: "混合格式", text: "# 标题\n\n这是一段文本，包含 **加粗** 和 `代码`。\n\n```javascript\nconsole.log('hello');\n```" },
    { name: "特殊字符", text: "特殊字符：<>&\"'" },
    { name: "空内容", text: "" },
    { name: "只有空格", text: "   " },
    { name: "只有换行", text: "\n\n\n" },
    { name: "Emoji", text: "🎉🚀✅❌⏳🔧" },
    { name: "长文本", text: "A".repeat(1000) },
  ];
  
  for (const testCase of testCases) {
    console.log(`\n测试: ${testCase.name}`);
    console.log(`内容: ${testCase.text.substring(0, 50)}${testCase.text.length > 50 ? '...' : ''}`);
    
    const card = buildTextCard(testCase.text);
    
    try {
      const resp = await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          content: JSON.stringify(card),
          msg_type: "interactive",
        },
      });
      
      console.log(`✅ ${testCase.name} 发送成功`);
    } catch (err: any) {
      console.error(`❌ ${testCase.name} 发送失败:`, err?.message ?? err);
      console.error("错误码:", err?.code);
      console.error("错误信息:", err?.msg);
    }
  }
  
  console.log("\n" + "=".repeat(50));
  console.log("✅ Markdown格式测试完成");
}

async function main(): Promise<void> {
  console.log("🚀 飞书Markdown格式测试");
  console.log("=".repeat(50));
  
  initClient();
  
  const chatId = process.argv[2];
  if (!chatId) {
    console.log("❌ 请提供 chat_id 参数");
    console.log("用法: npx tsx test-card-markdown.ts <chat_id>");
    return;
  }
  
  await testMarkdownFormats(chatId);
}

main().catch(console.error);
