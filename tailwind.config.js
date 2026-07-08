/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Deeper, more "serious bookkeeping" blue. The lighter shades stay for
        // pale backgrounds; the darker shades carry primary buttons.
        brand: {
          50: '#eef2ff',
          100: '#e0e7ff',
          500: '#3b5bdb',
          600: '#1e40af',
          700: '#1d3a9a',
          800: '#172e7a',
        },
      },
      boxShadow: {
        card: '0 1px 2px rgba(15, 23, 42, 0.04)',
      },
    },
  },
  plugins: [],
};
