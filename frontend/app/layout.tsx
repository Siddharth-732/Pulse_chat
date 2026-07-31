import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "react-hot-toast";
import AppInitializer from "../components/AppInitializer";
import GoogleAuthProvider from "../components/GoogleAuthProvider";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Bind",
  description: "Student Social Platform",
};

const themeBootstrapScript = `
(function () {
  try {
    var stored = localStorage.getItem("bind-theme");
    var theme = null;
    if (stored) {
      theme = JSON.parse(stored).state.theme;
    }
    if (!theme) {
      theme = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
    }
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body className={inter.className}>
        <GoogleAuthProvider>
          <AppInitializer />
          {children}
          <Toaster position="top-center" reverseOrder={false} />
        </GoogleAuthProvider>
      </body>
    </html>
  );
}
