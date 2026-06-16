import './globals.css'
import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import Header from '@/components/layout/Header'
import Footer from '@/components/layout/Footer'
import { AuthProvider } from '@/contexts/AuthContext'
import { OrganizationProvider } from '@/contexts/OrganizationContext'
import { Toaster } from '@/components/ui/toaster'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
    metadataBase: new URL('https://libraryos.live'),
    title: 'LibraryOS',
    description: 'The operating system for modern libraries. Organize, track, and share your book collections effortlessly.',
    icons: {
        icon: '/libraryos-logo.svg',
        apple: '/libraryos-logo.svg',
    },
    openGraph: {
        title: 'LibraryOS',
        description: 'The operating system for modern libraries. Organize, track, and share your book collections effortlessly.',
        type: 'website',
        siteName: 'LibraryOS',
        url: 'https://libraryos.live',
        images: [
            {
                url: '/og-cover.png',
                width: 1200,
                height: 630,
                alt: 'LibraryOS — the operating system for modern libraries',
            },
        ],
    },
    twitter: {
        card: 'summary_large_image',
        title: 'LibraryOS',
        description: 'The operating system for modern libraries.',
        images: ['/og-cover.png'],
    },
}

export default function RootLayout({
                                       children,
                                   }: {
    children: React.ReactNode
}) {
    return (
        <html lang="en">
        <body className={inter.className}>
        <AuthProvider>
            <OrganizationProvider>
                <div className="flex min-h-screen flex-col">
                    <Header />
                    <main className="flex-1">
                        {children}
                    </main>
                    <Footer />
                </div>
                <Toaster />
            </OrganizationProvider>
        </AuthProvider>
        </body>
        </html>
    )
}
