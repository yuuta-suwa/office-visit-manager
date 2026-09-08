import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "来社管理アプリ",
  description: "オフィス開閉・来社予約管理",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
