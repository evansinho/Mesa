import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Mesa — Business Dashboard',
  description: 'The financial operating system for your business',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}