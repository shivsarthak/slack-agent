"use client";

import { useState } from "react";
import { Bot, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await fetch("/api/auth/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setBusy(false);
    if (r.ok) setSent(true);
    else setError("Enter a valid email address.");
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,--theme(--color-primary/12%),transparent_60%)]"
      />
      <Card className="relative w-full max-w-sm shadow-lg">
        <CardHeader className="items-center text-center">
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <Bot className="size-6" />
          </div>
          <CardTitle className="text-lg">open-agent admin</CardTitle>
          <CardDescription>
            We’ll email you a secure sign-in link.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
                placeholder="you@example.com"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            {sent && (
              <p className="text-sm text-primary">
                Check your email for the sign-in link.
              </p>
            )}
            <Button
              type="submit"
              className="w-full"
              disabled={busy || email.length === 0}
            >
              <Mail className="size-4" />
              {busy ? "Sending…" : "Send sign-in link"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
