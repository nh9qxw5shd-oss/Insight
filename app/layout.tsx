import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'EMCC Insight — Strategic Operations Analytics',
  description: 'Trend, pattern and performance analysis for East Midlands Control Centre.',
  icons: { icon: '/icon.svg' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  )
}
