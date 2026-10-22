import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "AgriLink",
  description: "Farmers and buyers in Uganda, with money held safely until delivery.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-emerald-50 text-gray-900">{children}</body>
    </html>
  );
}
