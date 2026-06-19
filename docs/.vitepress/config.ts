import { defineConfig } from "vitepress";

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "qqdocs",
  description: "Tencent Docs (docs.qq.com) CLI and library — thin MCP JSON-RPC client.",
  // Deployed at https://snomiao.github.io/qqdocs/
  base: "/qqdocs/",
  lastUpdated: true,
  cleanUrls: true,
  ignoreDeadLinks: true,

  themeConfig: {
    socialLinks: [
      { icon: "github", link: "https://github.com/snomiao/qqdocs" },
    ],
    search: { provider: "local" },
  },

  locales: {
    root: {
      label: "English",
      lang: "en",
      themeConfig: {
        nav: [
          { text: "Guide", link: "/guide" },
          { text: "Internals", link: "/api-call-budget" },
        ],
        sidebar: [
          {
            text: "Introduction",
            items: [
              { text: "Overview", link: "/" },
              { text: "Guide", link: "/guide" },
            ],
          },
          {
            text: "Internals",
            items: [
              { text: "API call budget", link: "/api-call-budget" },
              { text: "Performance", link: "/perf" },
            ],
          },
        ],
      },
    },

    "zh-CN": {
      label: "简体中文",
      lang: "zh-CN",
      link: "/zh-CN/",
      themeConfig: {
        nav: [{ text: "指南", link: "/zh-CN/guide" }],
        sidebar: [
          {
            text: "简介",
            items: [
              { text: "概览", link: "/zh-CN/" },
              { text: "指南", link: "/zh-CN/guide" },
            ],
          },
        ],
      },
    },

    ja: {
      label: "日本語",
      lang: "ja",
      link: "/ja/",
      themeConfig: {
        nav: [{ text: "ガイド", link: "/ja/guide" }],
        sidebar: [
          {
            text: "はじめに",
            items: [
              { text: "概要", link: "/ja/" },
              { text: "ガイド", link: "/ja/guide" },
            ],
          },
        ],
      },
    },

    ko: {
      label: "한국어",
      lang: "ko",
      link: "/ko/",
      themeConfig: {
        nav: [{ text: "가이드", link: "/ko/guide" }],
        sidebar: [
          {
            text: "소개",
            items: [
              { text: "개요", link: "/ko/" },
              { text: "가이드", link: "/ko/guide" },
            ],
          },
        ],
      },
    },
  },
});
