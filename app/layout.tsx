import type { Metadata, Viewport } from "next";
import { Tajawal } from "next/font/google";
import "./globals.css";
import PwaRegister from "./PwaRegister";

const tajawal = Tajawal({
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "700", "800"],
  display: "swap",
  variable: "--font-tajawal",
});

export const metadata: Metadata = {
  title: "مهام قسم الإعلام والتوثيق",
  description: "منصة مشتركة لتنظيم مهام ومشاريع قسم الإعلام والتوثيق",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/logo.png",
    apple: [{ url: "/icons/apple-180.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "مهام الإعلام",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#b45309",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ar" dir="rtl" className={tajawal.variable}>
      <body>
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
