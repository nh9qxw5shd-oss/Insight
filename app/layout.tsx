import type { Metadata } from 'next'
import './globals.css'
import { withBase } from '@/lib/basePath'

export const metadata: Metadata = {
  title: 'EMCC Insight — Strategic Operations Analytics',
  description: 'Trend, pattern and performance analysis for East Midlands Control Centre.',
  icons: { icon: withBase('/icon.svg') },
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
