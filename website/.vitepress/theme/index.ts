import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import Playground from './Playground.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Playground', Playground);
  },
} satisfies Theme;
