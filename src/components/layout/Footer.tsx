import Image from 'next/image'
import Link from 'next/link'
import { BookOpen, Users, Building2, Mail } from 'lucide-react'

const footerLinks = {
    product: {
        title: 'Product',
        links: [
            { label: 'Browse Books', href: '/books' },
            { label: 'Dashboard', href: '/dashboard' },
            { label: 'Features', href: '/#features' },
        ],
    },
    organization: {
        title: 'Organization',
        links: [
            { label: 'Create Organization', href: '/org/create' },
            { label: 'Join Organization', href: '/org/join' },
            { label: 'Manage Members', href: '/org/members' },
        ],
    },
    resources: {
        title: 'Resources',
        links: [
            { label: 'Documentation', href: '#' },
            { label: 'API Reference', href: '#' },
            { label: 'Support', href: '#' },
        ],
    },
}

export default function Footer() {
    return (
        <footer className="border-t border-border/40 bg-muted/30">
            <div className="container py-12 md:py-16">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-8 lg:gap-12">
                    {/* Brand Section */}
                    <div className="lg:col-span-2">
                        <Link href="/" className="flex items-center gap-3 mb-4 group">
                            <div className="relative">
                                <Image
                                    src="/libraryos-logo.svg"
                                    alt="LibraryOS"
                                    width={40}
                                    height={40}
                                />
                            </div>
                            <span className="font-display font-bold text-xl bg-gradient-to-r from-[#02FF73] to-[#09ADAA] bg-clip-text text-transparent">
                                LibraryOS
                            </span>
                        </Link>
                        <p className="text-muted-foreground text-sm max-w-xs mb-6">
                            LibraryOS: The operating system for modern libraries. Organize, track, and share your book collections effortlessly.
                        </p>
                        <div className="flex items-center gap-4">
                            <a
                                href="#"
                                className="h-10 w-10 rounded-lg bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                                aria-label="GitHub"
                            >
                                <svg
                                    className="h-5 w-5"
                                    fill="currentColor"
                                    viewBox="0 0 24 24"
                                    aria-hidden="true"
                                >
                                    <path
                                        fillRule="evenodd"
                                        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                                        clipRule="evenodd"
                                    />
                                </svg>
                            </a>
                            <a
                                href="#"
                                className="h-10 w-10 rounded-lg bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                                aria-label="Twitter"
                            >
                                <svg
                                    className="h-5 w-5"
                                    fill="currentColor"
                                    viewBox="0 0 24 24"
                                    aria-hidden="true"
                                >
                                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                                </svg>
                            </a>
                        </div>
                    </div>

                    {/* Links Sections */}
                    {Object.values(footerLinks).map((section) => (
                        <div key={section.title}>
                            <h4 className="font-display font-semibold text-sm mb-4">
                                {section.title}
                            </h4>
                            <ul className="space-y-3">
                                {section.links.map((link) => (
                                    <li key={link.label}>
                                        <Link
                                            href={link.href}
                                            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                                        >
                                            {link.label}
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>

                {/* Bottom Bar */}
                <div className="border-t border-border/40 mt-12 pt-8 flex flex-col md:flex-row justify-between items-center gap-4">
                    <p className="text-sm text-muted-foreground">
                        &copy; {new Date().getFullYear()} LibraryOS. All rights reserved.
                    </p>
                    <div className="flex items-center gap-6 text-sm text-muted-foreground">
                        <Link href="/privacy" className="hover:text-foreground transition-colors">
                            Privacy Policy
                        </Link>
                        <Link href="/terms" className="hover:text-foreground transition-colors">
                            Terms of Service
                        </Link>
                        <Link href="/cookies" className="hover:text-foreground transition-colors">
                            Cookie Policy
                        </Link>
                    </div>
                </div>

                {/* Developer brand credit — Chan Meng */}
                <div className="border-t border-border/40 mt-8 pt-8 flex flex-col items-center gap-2 text-center">
                    <a
                        href="https://github.com/ChanMeng666"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                        <Image src="/brand/chan-meng-monkey.svg" alt="Chan Meng" width={22} height={22} />
                        <span className="font-medium">Built by Chan Meng — need a custom app like this one?</span>
                    </a>
                    <a
                        href="mailto:chanmeng.dev@gmail.com"
                        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                        chanmeng.dev@gmail.com
                    </a>
                </div>
            </div>
        </footer>
    )
}
