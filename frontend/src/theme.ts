import { defineTheme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral';

export const lobsterTheme = defineTheme({
  name: 'lobster-market',
  extends: neutralTheme,
  color: {
    accent: '#35D0BA',
    neutralStyle: 'cool',
    contrast: 'high',
  },
  typography: {
    scale: { base: 14, ratio: 1.2 },
    body: {
      family: 'Aptos',
      fallbacks: 'Segoe UI, sans-serif',
    },
    heading: {
      family: 'Bahnschrift SemiCondensed',
      fallbacks: 'Aptos Display, Segoe UI, sans-serif',
    },
    code: {
      family: 'Cascadia Code',
      fallbacks: 'SFMono-Regular, Consolas, monospace',
    },
  },
  radius: { base: 3, multiplier: 0.72 },
  motion: { fast: 140, medium: 320, ratio: 0.72 },
  tokens: {
    '--color-background-body': ['#EDF5F3', '#07131F'],
    '--color-background-surface': ['#FFFFFF', '#0C1C29'],
    '--color-background-card': ['#FFFFFF', '#102432'],
    '--color-background-muted': ['#DDEAE7', '#102230'],
    '--color-background-popover': ['#FFFFFF', '#152B3A'],
    '--color-text-primary': ['#10252A', '#EAF7F3'],
    '--color-text-secondary': ['#4B666B', '#8EA8AA'],
    '--color-text-disabled': ['#82999B', '#587176'],
    '--color-border': ['#B7CECA', '#1B3946'],
    '--color-border-emphasized': ['#88AAA4', '#315362'],
    '--color-accent': ['#087F70', '#35D0BA'],
    '--color-accent-muted': ['#35D0BA29', '#35D0BA1F'],
    '--color-on-accent': ['#FFFFFF', '#041A18'],
    '--color-text-accent': ['#076F63', '#62E4D1'],
    '--color-icon-accent': ['#087F70', '#35D0BA'],
    '--color-success': ['#07815B', '#49D89D'],
    '--color-error': ['#C64E43', '#FF806F'],
    '--color-warning': ['#A46A00', '#F4C05D'],
    '--color-shadow': ['#0A26261A', '#000A1099'],
  },
});
