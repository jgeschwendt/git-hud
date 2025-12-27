'use client'

import { useEffect, useState } from 'react'
import {
  getRepositories,
  getWorktrees,
  cloneRepository,
  createWorktree,
  deleteWorktree,
  deleteRepository,
  refreshWorktreeStatus
} from '@/app/actions'
import type { Repository, Worktree } from '@/lib/types'

export function Dashboard() {
  const [repos, setRepos] = useState<Repository[]>([])
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null)
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [cloneUrl, setCloneUrl] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function loadRepositories() {
    const result = await getRepositories()
    if (result.success && result.data) {
      setRepos(result.data)
    }
  }

  async function loadWorktrees(repoId: string) {
    const result = await getWorktrees(repoId)
    if (result.success && result.data) {
      setWorktrees(result.data)
    }
  }

  useEffect(() => {
    loadRepositories()
  }, [])

  useEffect(() => {
    if (selectedRepo) {
      loadWorktrees(selectedRepo)
    }
  }, [selectedRepo])

  async function handleClone() {
    if (!cloneUrl.trim()) return

    setLoading(true)
    setError(null)

    const result = await cloneRepository(cloneUrl)
    if (result.success && result.data) {
      setCloneUrl('')
      await loadRepositories()
      setSelectedRepo(result.data.repo_id)
    } else {
      setError(result.error || 'Clone failed')
    }

    setLoading(false)
  }

  async function handleCreateWorktree() {
    if (!selectedRepo || !newBranch.trim()) return

    setLoading(true)
    setError(null)

    const result = await createWorktree(selectedRepo, newBranch, true)
    if (result.success) {
      setNewBranch('')
      await loadWorktrees(selectedRepo)
    } else {
      setError(result.error || 'Create worktree failed')
    }

    setLoading(false)
  }

  async function handleDeleteWorktree(path: string) {
    if (!confirm(`Delete worktree: ${path.split('/').pop()}?`)) return

    setLoading(true)
    const result = await deleteWorktree(path)
    if (result.success && selectedRepo) {
      await loadWorktrees(selectedRepo)
    } else {
      setError(result.error || 'Delete failed')
    }
    setLoading(false)
  }

  async function handleDeleteRepo(repoId: string) {
    const repo = repos.find(r => r.id === repoId)
    if (!confirm(`Delete repository: ${repo?.name}?`)) return

    setLoading(true)
    const result = await deleteRepository(repoId)
    if (result.success) {
      setSelectedRepo(null)
      await loadRepositories()
    } else {
      setError(result.error || 'Delete failed')
    }
    setLoading(false)
  }

  async function handleRefreshStatus(path: string) {
    await refreshWorktreeStatus(path)
    if (selectedRepo) {
      await loadWorktrees(selectedRepo)
    }
  }

  const selectedRepoData = repos.find(r => r.id === selectedRepo)

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: '1400px', margin: '0 auto' }}>
      <header style={{ marginBottom: '2rem' }}>
        <h1 style={{ margin: 0, fontSize: '2rem' }}>git-hud</h1>
        <p style={{ color: '#666', margin: '0.5rem 0 0' }}>v0.1.1 - Git worktree dashboard</p>
      </header>

      {error && (
        <div style={{ background: '#fee', border: '1px solid #c00', padding: '1rem', marginBottom: '1rem', borderRadius: '4px' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: '2rem' }}>
        {/* Sidebar */}
        <div>
          <h2 style={{ fontSize: '1.2rem', marginBottom: '1rem' }}>Repositories</h2>

          <div style={{ marginBottom: '1rem' }}>
            <input
              type="text"
              placeholder="Git URL"
              value={cloneUrl}
              onChange={(e) => setCloneUrl(e.target.value)}
              style={{ width: '100%', padding: '0.5rem', marginBottom: '0.5rem', border: '1px solid #ddd', borderRadius: '4px' }}
            />
            <button
              onClick={handleClone}
              disabled={loading || !cloneUrl.trim()}
              style={{
                width: '100%',
                padding: '0.5rem',
                background: '#0070f3',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading || !cloneUrl.trim() ? 0.5 : 1
              }}
            >
              {loading ? 'Cloning...' : 'Clone'}
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {repos.map(repo => (
              <div
                key={repo.id}
                style={{
                  padding: '0.75rem',
                  background: selectedRepo === repo.id ? '#f0f0f0' : 'white',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  cursor: 'pointer'
                }}
                onClick={() => setSelectedRepo(repo.id)}
              >
                <div style={{ fontWeight: 500 }}>{repo.name}</div>
                <div style={{ fontSize: '0.85rem', color: '#666' }}>
                  {repo.provider}/{repo.username}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Main content */}
        <div>
          {selectedRepoData ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h2 style={{ fontSize: '1.5rem', margin: 0 }}>{selectedRepoData.name}</h2>
                <button
                  onClick={() => handleDeleteRepo(selectedRepoData.id)}
                  style={{
                    padding: '0.5rem 1rem',
                    background: '#c00',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  Delete Repo
                </button>
              </div>

              <div style={{ marginBottom: '1.5rem' }}>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input
                    type="text"
                    placeholder="New branch name"
                    value={newBranch}
                    onChange={(e) => setNewBranch(e.target.value)}
                    style={{ flex: 1, padding: '0.5rem', border: '1px solid #ddd', borderRadius: '4px' }}
                  />
                  <button
                    onClick={handleCreateWorktree}
                    disabled={loading || !newBranch.trim()}
                    style={{
                      padding: '0.5rem 1rem',
                      background: '#0070f3',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: loading ? 'not-allowed' : 'pointer',
                      opacity: loading || !newBranch.trim() ? 0.5 : 1
                    }}
                  >
                    Create Worktree
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {worktrees.map(wt => (
                  <div
                    key={wt.path}
                    style={{
                      padding: '1rem',
                      background: 'white',
                      border: '1px solid #ddd',
                      borderRadius: '4px'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 500, marginBottom: '0.25rem' }}>
                          {wt.path.split('/').pop()}
                        </div>
                        <div style={{ fontSize: '0.9rem', color: '#666', marginBottom: '0.5rem' }}>
                          {wt.branch}
                        </div>
                        <div style={{ display: 'flex', gap: '1rem', fontSize: '0.85rem' }}>
                          <span style={{ color: wt.dirty ? '#c00' : '#090' }}>
                            {wt.dirty ? '● Dirty' : '○ Clean'}
                          </span>
                          {wt.ahead > 0 && <span style={{ color: '#0070f3' }}>↑ {wt.ahead}</span>}
                          {wt.behind > 0 && <span style={{ color: '#f60' }}>↓ {wt.behind}</span>}
                          <span style={{
                            color: wt.status === 'ready' ? '#090' : wt.status === 'error' ? '#c00' : '#f60'
                          }}>
                            {wt.status}
                          </span>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button
                          onClick={() => handleRefreshStatus(wt.path)}
                          style={{
                            padding: '0.4rem 0.8rem',
                            background: '#f0f0f0',
                            border: '1px solid #ddd',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '0.85rem'
                          }}
                        >
                          Refresh
                        </button>
                        {!wt.path.endsWith('__main__') && (
                          <button
                            onClick={() => handleDeleteWorktree(wt.path)}
                            style={{
                              padding: '0.4rem 0.8rem',
                              background: '#fee',
                              border: '1px solid #c00',
                              color: '#c00',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              fontSize: '0.85rem'
                            }}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </div>
                    <div style={{ fontSize: '0.8rem', color: '#999', marginTop: '0.5rem' }}>
                      {wt.path}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div style={{ textAlign: 'center', padding: '4rem', color: '#999' }}>
              Select a repository or clone a new one
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
