import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'EMCC Insight — Strategic Operations Analytics',
  description: 'Trend, pattern and performance analysis for East Midlands Control Centre.',
  icons: { icon: '/icon.svg' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          try {
            var t = localStorage.getItem('theme') || 'dark';
            document.documentElement.setAttribute('data-theme', t);
          } catch(e) {
            document.documentElement.setAttribute('data-theme', 'dark');
          }
        ` }} />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  )
}
