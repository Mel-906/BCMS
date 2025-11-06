import Link from "next/link";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "BCMS OCR Dashboard",
  description: "Supabase-backed dashboard for BCMS YomiToku pipeline",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <div className="app-shell">
          <header className="app-header">
            <div className="app-header__inner">
              <Link href="/" className="app-header__brand">
                BCMS OCR Dashboard
              </Link>
              <nav className="app-header__nav">
                <Link href="/">Dashboard</Link>
                <Link href="/projects">Projects</Link>
                <Link href="/scan">Scan</Link>
              </nav>
            </div>
          </header>
          <div>{children}</div>
        </div>
      </body>
    </html>
  );
}
