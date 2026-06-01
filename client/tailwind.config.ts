import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          base: '#0F0D0B',
          panel: '#1A1610',
          elevated: '#221C14',
          hover: '#2A2218',
        },
        accent: {
          DEFAULT: '#E8930A',
          dim: 'rgba(232,147,10,0.12)',
          glow: 'rgba(232,147,10,0.35)',
        },
        warn: '#F5B700',
        error: '#FF4D6D',
        success: '#4ADE80',
      },
      fontFamily: {
        ui: ['Outfit', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'monospace'],
      },
      borderColor: {
        DEFAULT: 'rgba(255,245,235,0.07)',
        strong: 'rgba(255,245,235,0.13)',
      },
    },
  },
  plugins: [],
} satisfies Config;
