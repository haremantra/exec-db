import { ClerkProvider, SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "exec-db",
  description: "Internal exec database",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>
          <div className="mx-auto max-w-6xl px-6 py-8">
            <header className="mb-8 flex items-center justify-between border-b border-neutral-200 pb-4 dark:border-neutral-800">
              <h1 className="text-lg font-semibold tracking-tight">exec-db</h1>
              <nav className="flex gap-4 text-sm text-neutral-600 dark:text-neutral-400">
                <a href="/">Home</a>
                <a href="/dashboard">Dashboard</a>
                <a href="/retrospective">Retrospective</a>
                <a href="/crm/contacts">CRM</a>
                <a href="/dashboard">Dashboard</a>
                <a href="/retrospective">Retro</a>
                <a href="/pm/projects">PM</a>
                <a href="/status">Status</a>
              </nav>
              <div className="flex items-center gap-2">
                <SignedIn>
                  <UserButton afterSignOutUrl="/sign-in" />
                </SignedIn>
                <SignedOut>
                  <SignInButton mode="redirect">
                    <button
                      type="button"
                      className="rounded bg-neutral-900 px-3 py-1 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
                    >
                      Sign in
                    </button>
                  </SignInButton>
                </SignedOut>
              </div>
            </header>
            <main>{children}</main>
          </div>
        </body>
      </html>
    </ClerkProvider>
  );
}
