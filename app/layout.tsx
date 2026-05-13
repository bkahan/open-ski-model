import type { Metadata, Viewport } from "next";
// Order matters: maplibre-gl.css first so our overrides in globals.css
// take precedence. Hoisting these CSS imports to the root server-component
// layout guarantees they're emitted into the static stylesheet bundle
// (App Router can drop CSS imported only from dynamically-loaded client
// components, which manifests as a transparent map canvas + missing
// controls — exactly the symptom we just hit).
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";
import RegisterSW from "@/components/RegisterSW";

export const metadata: Metadata = {
  title: "Open Ski Model",
  description:
    "Generate 3D-printable topographic models of ski mountains. Free, open data, no API keys.",
  manifest: "/manifest.json",
  applicationName: "Open Ski Model",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Open Ski Model",
  },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: "/icon.svg",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b1220",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate950 text-snow antialiased">
        <RegisterSW />
        {children}
      </body>
    </html>
  );
}
