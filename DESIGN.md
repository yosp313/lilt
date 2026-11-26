# Lilt interface

Lilt is a desktop notebook for meetings. The Meeting desk shows recent notes and the next calendar event. The toolbar holds search, Ask Lilt, and New note. Keep those actions available throughout the workspace.

## Navigation and editing

- Use one sidebar for views, spaces, and folders. Opening a note gives the editor the main area. Its back button returns to the view that opened it.
- Search from the toolbar covers all notes. Keep transcript search inside the current note.
- Keep Notes, Summary, and Transcript easy to switch between. When Lilt creates a summary, open it.
- Use an explicit recording action. Show the current recording state and a way back to it while the user browses other views.

## Styling and copy

- Use the shared light and dark colors in `src/index.css`. Use warm paper surfaces, fine dividers, and a green accent for actions and selection.
- Use serif headings for pages and note titles. Use sans-serif text for controls, note content, and dense lists. Reserve monospace for counters and timestamps.
- Use rows for collections. Use borders to group controls and shadows for floating UI.
- Give empty states a next action where one exists. Label controls with the action they take, especially when an action starts recording or opens a call.
- Preserve visible keyboard focus. Use native modal dialogs and keep recording and navigation controls reachable by keyboard.
