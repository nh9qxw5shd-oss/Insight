/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        nr: {
          orange: '#E05206',
          'orange-soft': '#F47A3D',
          blue: '#003366',
          navy: '#001F45',
          steel: '#4A6FA5',
          amber: '#F39C12',
          red: '#C0392B',
          green: '#27AE60',
        },
        ink: {
          900: '#070B16',
          800: '#0A0F1E',
          700: '#0F1729',
          600: '#131C35',
          500: '#162040',
          400: '#1B2A55',
        },
        bone: {
          50:  '#FAF7F0',
          100: '#F2EDE0',
          200: '#E8EDF5',
          300: '#A9B5C9',
          400: '#7A8BA8',
          500: '#4A5A72',
        },
      },
      fontFamily: {
        sans: ['"Inter Tight"', 'system-ui', 'sans-serif'],
        display: ['Fraunces', 'Georgia', 'serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      letterSpacing: {
        micro: '0.18em',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
        'sweep': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'fade-up':    'fade-up 0.5s ease-out forwards',
        'pulse-soft': 'pulse-soft 2.4s ease-in-out infinite',
        'sweep':      'sweep 3s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
