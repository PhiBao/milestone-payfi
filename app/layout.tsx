import type { Metadata } from "next";
import { JetBrains_Mono, Outfit } from "next/font/google";
import { Providers } from "./providers";
import "./globals.css";

const sansFont = Outfit({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans"
});

const monoFont = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono"
});

export const metadata: Metadata = {
  title: "Milestone PayFi",
  description:
    "Programmable milestone settlement and receivable-backed early payouts for cross-border freelancers."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${sansFont.variable} ${monoFont.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
