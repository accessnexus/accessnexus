import { h } from "vue";
import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import GithubStar from "./GithubStar.vue";
import HomeLanding from "./HomeLanding.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      "nav-bar-content-after": () => h(GithubStar),
    });
  },
  enhanceApp({ app }) {
    app.component("HomeLanding", HomeLanding);
  },
} satisfies Theme;
