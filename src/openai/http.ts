import type { TenantRole } from "../dashboard/auth.ts";
import type { OnboardingAttempt, OpenAICodexOnboarding } from "./onboarding.ts";

type Authorization = { readonly userId: string } | Response;

export interface OpenAICodexHttpDependencies {
  authorize(
    request: Request,
    tenantId: string,
    allowed: readonly TenantRole[],
  ): Promise<Authorization>;
  forTenant(tenantId: string): OpenAICodexOnboarding;
}

const ADMIN_ROLES = ["owner", "admin"] as const;

/** Framework-neutral HTTP seam. Credential material is absent from every response shape. */
export function createOpenAICodexOnboardingHttpHandler(
  dependencies: OpenAICodexHttpDependencies,
) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const match = url.pathname.match(
      /^\/api\/tenants\/([^/]+)\/openai-codex(?:\/(.*))?$/,
    );
    if (!match) return json({ error: "not found" }, 404);
    const tenant = decodeURIComponent(match[1]!);
    const route = match[2] ?? "";
    const authorized = await dependencies.authorize(
      request,
      tenant,
      ADMIN_ROLES,
    );
    if (authorized instanceof Response) return authorized;
    const onboarding = dependencies.forTenant(tenant);

    try {
      if (route === "onboarding" && request.method === "POST") {
        return json(
          publicAttempt(await onboarding.initiate(authorized.userId)),
          202,
        );
      }
      const attemptMatch = route.match(/^onboarding\/([^/]+)$/);
      if (attemptMatch && request.method === "GET") {
        const attempt = await onboarding.status(
          decodeURIComponent(attemptMatch[1]!),
        );
        return attempt
          ? json(publicAttempt(attempt))
          : json({ error: "not found" }, 404);
      }
      if (attemptMatch && request.method === "DELETE") {
        await onboarding.cancel(decodeURIComponent(attemptMatch[1]!));
        return new Response(null, { status: 204 });
      }
      if (route === "credential" && request.method === "GET")
        return json(await onboarding.credentialStatus());
      if (route === "credential/refresh" && request.method === "POST")
        return json(await onboarding.refresh());
      if (route === "credential" && request.method === "DELETE")
        return json(await onboarding.revoke());
      return json({ error: "not found" }, 404);
    } catch {
      // Provider and persistence failures may contain upstream response bodies.
      return json({ error: "OpenAI Codex operation failed" }, 502);
    }
  };
}

function publicAttempt(attempt: OnboardingAttempt) {
  return {
    id: attempt.id,
    status: attempt.status,
    ...(attempt.verificationUrl
      ? { verificationUrl: attempt.verificationUrl }
      : {}),
    ...(attempt.userCode ? { userCode: attempt.userCode } : {}),
    ...(attempt.expiresAt ? { expiresAt: attempt.expiresAt } : {}),
    ...(attempt.failure ? { failure: attempt.failure } : {}),
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
