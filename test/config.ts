import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface FeishuTestConfig {
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
  encryptKey: string;
  verificationToken: string;
  chatId: string;
}

function loadFromSettingsFile(): Partial<FeishuTestConfig> {
  const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
  if (!existsSync(settingsPath)) return {};

  try {
    const raw = readFileSync(settingsPath, "utf-8");
    const json = JSON.parse(raw);
    const fs = json?.feishu;
    if (!fs || typeof fs !== "object") return {};

    return {
      appId: fs.appId ?? fs.app_id ?? "",
      appSecret: fs.appSecret ?? fs.app_secret ?? "",
      domain: fs.domain ?? "feishu",
      encryptKey: fs.encryptKey ?? fs.encrypt_key ?? "",
      verificationToken: fs.verificationToken ?? fs.verification_token ?? "",
    };
  } catch {
    return {};
  }
}

function loadFromEnv(): Partial<FeishuTestConfig> {
  return {
    appId: process.env.FEISHU_APP_ID ?? "",
    appSecret: process.env.FEISHU_APP_SECRET ?? "",
    domain: (process.env.FEISHU_DOMAIN as "feishu" | "lark") ?? "feishu",
    encryptKey: process.env.FEISHU_ENCRYPT_KEY ?? "",
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN ?? "",
    chatId: process.env.FEISHU_TEST_CHAT_ID ?? "",
  };
}

export function loadTestConfig(): FeishuTestConfig {
  const fileConfig = loadFromSettingsFile();
  const envConfig = loadFromEnv();

  const config: FeishuTestConfig = {
    appId: envConfig.appId || fileConfig.appId || "",
    appSecret: envConfig.appSecret || fileConfig.appSecret || "",
    domain: envConfig.domain || fileConfig.domain || "feishu",
    encryptKey: envConfig.encryptKey || fileConfig.encryptKey || "",
    verificationToken: envConfig.verificationToken || fileConfig.verificationToken || "",
    chatId: envConfig.chatId || fileConfig.chatId || "",
  };

  if (!config.appId || !config.appSecret) {
    console.error("❌ 飞书配置缺失请设置环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET");
    console.error("   或在 ~/.pi/agent/settings.json 中配置 feishu 段");
    process.exit(1);
  }

  return config;
}
