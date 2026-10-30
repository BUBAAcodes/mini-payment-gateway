import type { Metadata } from 'next';
import { Instrument_Sans, Inter } from 'next/font/google';
import { BRAND_NAME } from '@/lib/checkout';
import './globals.css';

// Variable Inter with its optical-size axis: body text at small sizes, Inter Display for headings.
const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  axes: ['opsz'],
});

// The reference's pill labels.
const instrumentSans = Instrument_Sans({
  variable: '--font-instrument-sans',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: BRAND_NAME,
  description: 'A test-mode payment gateway. No real money moves.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${inter.variable} ${instrumentSans.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans">{children}</body>
    </html>
  );
}
