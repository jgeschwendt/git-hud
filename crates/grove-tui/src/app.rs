//! Chat application state and event handling

use chrono::{DateTime, Local};
use crossterm::event::{self, Event, KeyCode, KeyModifiers};
use ratatui::prelude::*;
use std::time::Duration;
use tokio::sync::mpsc;
use tui_textarea::TextArea;

/// Chat message
#[derive(Debug, Clone)]
pub struct Message {
    pub role: Role,
    pub content: String,
    pub timestamp: DateTime<Local>,
}

/// Message role
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
    System,
}

/// Input mode
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Insert,
    Normal,
}

/// Commands to execute
#[derive(Debug, Clone)]
pub enum Command {
    Clone(String),
    CreateWorktree { repo_id: String, branch: String },
    DeleteWorktree { path: String },
    Open(String),
    Refresh(String),
    Quit,
}

/// Server status
#[derive(Debug, Clone)]
pub enum ServerStatus {
    Starting,
    Running { port: u16 },
    Error(String),
}

/// Chat application
pub struct ChatApp {
    /// Chat messages
    pub messages: Vec<Message>,
    /// Text input
    pub input: TextArea<'static>,
    /// Scroll offset (from bottom)
    pub scroll_offset: usize,
    /// Current mode
    pub mode: Mode,
    /// Server status
    pub server_status: ServerStatus,
    /// Server port
    pub port: u16,
    /// Command sender
    command_tx: mpsc::Sender<Command>,
}

impl ChatApp {
    /// Create new chat app
    pub fn new(port: u16) -> (Self, mpsc::Receiver<Command>) {
        let (command_tx, command_rx) = mpsc::channel(32);

        let mut input = TextArea::default();
        input.set_cursor_line_style(Style::default());
        input.set_placeholder_text("Type a message or /help for commands...");

        let app = Self {
            messages: vec![Message {
                role: Role::System,
                content: "Welcome to grove. Type /help for available commands.".to_string(),
                timestamp: Local::now(),
            }],
            input,
            scroll_offset: 0,
            mode: Mode::Insert,
            server_status: ServerStatus::Running { port },
            port,
            command_tx,
        };

        (app, command_rx)
    }

    /// Run the TUI event loop
    pub async fn run(&mut self, terminal: &mut Terminal<impl Backend>) -> anyhow::Result<()> {
        loop {
            // Draw UI
            terminal.draw(|frame| crate::ui::render(frame, self))?;

            // Poll for events (50ms timeout)
            if event::poll(Duration::from_millis(50))? {
                if let Event::Key(key) = event::read()? {
                    if self.handle_key(key).await? {
                        break; // Quit signal
                    }
                }
            }
        }
        Ok(())
    }

    /// Handle key event, returns true if should quit
    async fn handle_key(&mut self, key: event::KeyEvent) -> anyhow::Result<bool> {
        match self.mode {
            Mode::Insert => match (key.code, key.modifiers) {
                // Submit
                (KeyCode::Enter, KeyModifiers::NONE) => {
                    let content: String = self.input.lines().join("\n");
                    if !content.trim().is_empty() {
                        self.submit_message(content).await?;
                    }
                }
                // Multi-line
                (KeyCode::Enter, KeyModifiers::SHIFT) => {
                    self.input.insert_newline();
                }
                // Clear or switch mode
                (KeyCode::Esc, _) => {
                    if self.input.is_empty() {
                        self.mode = Mode::Normal;
                    } else {
                        self.input.select_all();
                        self.input.cut();
                    }
                }
                // Quit
                (KeyCode::Char('c'), KeyModifiers::CONTROL) => {
                    return Ok(true);
                }
                // Scroll
                (KeyCode::Up, KeyModifiers::CONTROL) | (KeyCode::PageUp, _) => {
                    self.scroll_up(10);
                }
                (KeyCode::Down, KeyModifiers::CONTROL) | (KeyCode::PageDown, _) => {
                    self.scroll_down(10);
                }
                // Pass to textarea
                _ => {
                    self.input.input(key);
                }
            },
            Mode::Normal => match key.code {
                KeyCode::Char('i') => self.mode = Mode::Insert,
                KeyCode::Char('q') => return Ok(true),
                KeyCode::Char('j') => self.scroll_down(1),
                KeyCode::Char('k') => self.scroll_up(1),
                KeyCode::Char('G') => self.scroll_to_bottom(),
                KeyCode::Char('g') => self.scroll_to_top(),
                _ => {}
            },
        }
        Ok(false)
    }

    /// Submit a message
    async fn submit_message(&mut self, content: String) -> anyhow::Result<()> {
        // Add user message
        self.messages.push(Message {
            role: Role::User,
            content: content.clone(),
            timestamp: Local::now(),
        });

        // Clear input
        self.input.select_all();
        self.input.cut();
        self.scroll_to_bottom();

        // Handle command or natural language
        if content.starts_with('/') {
            self.handle_command(&content).await?;
        } else {
            // For now, just echo back
            self.messages.push(Message {
                role: Role::System,
                content: "Natural language commands coming soon. Use /help for available commands."
                    .to_string(),
                timestamp: Local::now(),
            });
        }

        Ok(())
    }

    /// Handle slash command
    async fn handle_command(&mut self, input: &str) -> anyhow::Result<()> {
        let parts: Vec<&str> = input.split_whitespace().collect();
        let cmd = parts.first().map(|s| *s).unwrap_or("");

        match cmd {
            "/help" | "/?" => {
                self.messages.push(Message {
                    role: Role::System,
                    content: r#"Commands:
  /clone <url>           Clone a repository
  /worktree <branch>     Create worktree
  /delete <path>         Delete a worktree
  /open <path>           Open in VS Code
  /list                  List repositories
  /refresh               Refresh all
  /status                Show server status
  /quit, /q              Exit grove

Navigation:
  Ctrl+↑/↓, PgUp/PgDn    Scroll
  Esc                    Clear / Normal mode
  Ctrl+C                 Quit"#
                        .to_string(),
                    timestamp: Local::now(),
                });
            }
            "/clone" => {
                if let Some(url) = parts.get(1) {
                    self.command_tx.send(Command::Clone(url.to_string())).await?;
                    self.messages.push(Message {
                        role: Role::System,
                        content: format!("Cloning {}...", url),
                        timestamp: Local::now(),
                    });
                } else {
                    self.messages.push(Message {
                        role: Role::System,
                        content: "Usage: /clone <url>".to_string(),
                        timestamp: Local::now(),
                    });
                }
            }
            "/status" => {
                let status = match &self.server_status {
                    ServerStatus::Starting => "Server starting...".to_string(),
                    ServerStatus::Running { port } => {
                        format!("Server running on http://localhost:{}", port)
                    }
                    ServerStatus::Error(e) => format!("Server error: {}", e),
                };
                self.messages.push(Message {
                    role: Role::System,
                    content: status,
                    timestamp: Local::now(),
                });
            }
            "/quit" | "/q" => {
                self.command_tx.send(Command::Quit).await?;
            }
            _ => {
                self.messages.push(Message {
                    role: Role::System,
                    content: format!("Unknown command: {}. Type /help for commands.", cmd),
                    timestamp: Local::now(),
                });
            }
        }

        Ok(())
    }

    fn scroll_up(&mut self, n: usize) {
        self.scroll_offset = self.scroll_offset.saturating_add(n);
    }

    fn scroll_down(&mut self, n: usize) {
        self.scroll_offset = self.scroll_offset.saturating_sub(n);
    }

    fn scroll_to_top(&mut self) {
        self.scroll_offset = usize::MAX;
    }

    fn scroll_to_bottom(&mut self) {
        self.scroll_offset = 0;
    }
}
