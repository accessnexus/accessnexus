import { h } from "vue";
import DefaultTheme from "vitepress/theme";
import GithubStar from "./GithubStar.vue";
import HeroRls from "./HeroRls.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      "home-hero-image": () => h(HeroRls),
      "nav-bar-content-after": () => h(GithubStar),
    });
  },
};
