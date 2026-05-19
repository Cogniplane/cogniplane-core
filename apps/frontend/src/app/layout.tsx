import type { Metadata } from "next";
import { Manrope, Inter } from "next/font/google";
import { ReactNode } from "react";

import "./globals.css";
import { OverlayBootstrap } from "../overlay-bootstrap";
import { Providers } from "./providers";

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-headline",
  display: "swap"
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap"
});

export const metadata: Metadata = {
  title: "Cogniplane",
  description: "Cogniplane — the intelligent control plane for AI.",
  icons: {
    icon: [{ url: "/brand/favicon-32.png", sizes: "32x32", type: "image/png" }],
    apple: [{ url: "/brand/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    shortcut: ["/brand/favicon-32.png"]
  }
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/theme-init.js" />
      </head>
      <body className={`${manrope.variable} ${inter.variable}`}>
        <OverlayBootstrap />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
