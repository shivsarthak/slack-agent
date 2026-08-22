import type {
  AuthEvent,
  OAuthAuth,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import type {
  DeviceLoginNotice,
  OpenAICodexAuthAdapter,
  OpenAICodexCredential,
} from "./onboarding.ts";

/** Adapt Pi's supported provider-auth interaction without owning OAuth endpoints. */
export function createPiOpenAICodexAuthAdapter(
  oauth: Pick<OAuthAuth, "login" | "refresh">,
): OpenAICodexAuthAdapter {
  return {
    async login(input) {
      const credential = await oauth.login({
        signal: input.signal,
        async prompt(prompt) {
          if (prompt.type === "select") return "device_code";
          throw new Error(
            "OpenAI Codex device login requested unexpected input",
          );
        },
        notify(event) {
          const notice = deviceNotice(event);
          if (notice) input.onDeviceCode(notice);
        },
      });
      return validateCredential(credential);
    },
    async refresh(credential, signal) {
      return validateCredential(
        await oauth.refresh(credential as OAuthCredential, signal),
      );
    },
  };
}

/** Resolve Pi lazily so browser bundles never import its Node-only OAuth flow. */
export async function loadPiOpenAICodexAuthAdapter(): Promise<OpenAICodexAuthAdapter> {
  const { openaiCodexProvider } = await import(
    "@earendil-works/pi-ai/providers/openai-codex"
  );
  const oauth = openaiCodexProvider().auth.oauth;
  if (!oauth) throw new Error("Pi OpenAI Codex OAuth is unavailable");
  return createPiOpenAICodexAuthAdapter(oauth);
}

function deviceNotice(event: AuthEvent): DeviceLoginNotice | undefined {
  if (event.type !== "device_code") return undefined;
  return {
    verificationUrl: event.verificationUri,
    userCode: event.userCode,
    ...(event.intervalSeconds !== undefined
      ? { intervalSeconds: event.intervalSeconds }
      : {}),
    ...(event.expiresInSeconds !== undefined
      ? { expiresInSeconds: event.expiresInSeconds }
      : {}),
  };
}

function validateCredential(value: OAuthCredential): OpenAICodexCredential {
  if (
    value.type !== "oauth" ||
    typeof value.access !== "string" ||
    value.access === "" ||
    typeof value.refresh !== "string" ||
    value.refresh === "" ||
    typeof value.expires !== "number" ||
    !Number.isFinite(value.expires)
  )
    throw new Error("Pi returned an invalid OpenAI Codex credential");
  return value as OpenAICodexCredential;
}
