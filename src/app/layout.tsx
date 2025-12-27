export const metadata = {
  title: 'git-hud v0.1.1',
  description: 'Git worktree dashboard - Manage bare repositories and worktrees',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
