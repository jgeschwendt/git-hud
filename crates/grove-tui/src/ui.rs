//! UI rendering

use crate::app::{ChatApp, Mode, Role, ServerStatus};
use ratatui::{prelude::*, widgets::*};

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Render the chat UI
pub fn render(frame: &mut Frame, app: &ChatApp) {
    let chunks = Layout::vertical([
        Constraint::Length(2), // Header
        Constraint::Min(1),    // Messages
        Constraint::Length(3), // Input
    ])
    .split(frame.area());

    render_header(frame, app, chunks[0]);
    render_messages(frame, app, chunks[1]);
    render_input(frame, app, chunks[2]);
}

fn render_header(frame: &mut Frame, app: &ChatApp, area: Rect) {
    let chunks = Layout::vertical([Constraint::Length(1), Constraint::Length(1)]).split(area);

    // Title
    let title = Line::from(vec![
        Span::styled("grove ", Style::new().green().bold()),
        Span::styled(format!("v{}", VERSION), Style::new().green()),
    ]);
    frame.render_widget(Paragraph::new(title), chunks[0]);

    // Status line
    let server_status = match &app.server_status {
        ServerStatus::Starting => Span::styled("Starting...", Style::new().yellow()),
        ServerStatus::Running { port } => {
            Span::styled(format!("http://localhost:{}", port), Style::new().cyan())
        }
        ServerStatus::Error(e) => Span::styled(e.clone(), Style::new().red()),
    };

    let mode_indicator = match app.mode {
        Mode::Normal => Span::styled(" [NORMAL]", Style::new().blue().bold()),
        Mode::Insert => Span::styled(" [INSERT]", Style::new().green().bold()),
    };

    let status_line = Line::from(vec![server_status, mode_indicator]);
    frame.render_widget(Paragraph::new(status_line), chunks[1]);
}

fn render_messages(frame: &mut Frame, app: &ChatApp, area: Rect) {
    let block = Block::default()
        .borders(Borders::TOP | Borders::BOTTOM)
        .border_style(Style::new().gray());

    let inner = block.inner(area);
    frame.render_widget(block, area);

    // Build message lines
    let mut lines: Vec<Line> = Vec::new();

    for msg in &app.messages {
        let (prefix, style) = match msg.role {
            Role::User => ("❯ ", Style::new().bold().white()),
            Role::Assistant => ("  ", Style::new().white()),
            Role::System => ("• ", Style::new().gray().italic()),
        };

        let timestamp = msg.timestamp.format("%H:%M").to_string();

        for (i, line) in msg.content.lines().enumerate() {
            let mut spans = vec![];

            if i == 0 {
                spans.push(Span::styled(format!("{} ", timestamp), Style::new().gray().dim()));
                spans.push(Span::styled(prefix, style));
            } else {
                spans.push(Span::raw("       ")); // Indent continuation
            }

            spans.push(Span::styled(line, style));
            lines.push(Line::from(spans));
        }

        lines.push(Line::raw("")); // Spacing
    }

    // Calculate scroll
    let visible_height = inner.height as usize;
    let total_lines = lines.len();

    let scroll = if total_lines > visible_height {
        let max_scroll = total_lines - visible_height;
        max_scroll.saturating_sub(app.scroll_offset)
    } else {
        0
    };

    let paragraph = Paragraph::new(lines)
        .scroll((scroll as u16, 0))
        .wrap(Wrap { trim: false });

    frame.render_widget(paragraph, inner);
}

fn render_input(frame: &mut Frame, app: &ChatApp, area: Rect) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(match app.mode {
            Mode::Insert => Style::new().green(),
            _ => Style::new().gray(),
        })
        .title(match app.mode {
            Mode::Insert => " Message (Enter to send) ",
            Mode::Normal => " Press 'i' to type ",
        });

    let inner = block.inner(area);
    frame.render_widget(block, area);
    frame.render_widget(&app.input, inner);
}
