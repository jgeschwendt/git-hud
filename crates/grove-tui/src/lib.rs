//! grove-tui: Terminal chat UI for grove
//!
//! Provides an interactive chat interface like `claude`.
//! See README.md for UI layout and flow diagrams.

mod app;
mod ui;

pub use app::{ChatApp, Command, Message, Mode, Role};
