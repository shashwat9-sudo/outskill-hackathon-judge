import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Outskill Hackathon Judge',
  description: 'Internal hackathon submission and assessment platform.',
  // Judging material must never be indexed, and neither should a submission page.
  robots: { index: false, follow: false, nocache: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="skip-link">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
