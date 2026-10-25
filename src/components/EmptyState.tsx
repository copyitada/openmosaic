import { Compass, Gamepad2, LineChart, Server } from 'lucide-react'
import type { ReactNode } from 'react'

const suggestions = [
  {
    icon: Gamepad2,
    label: 'Build a game',
    prompt:
      'Build a polished snake game in a single HTML file inside ./games, then run a quick sanity check on it.',
  },
  {
    icon: LineChart,
    label: 'Analyze data',
    prompt:
      'Create ./data/sales.csv with 24 rows of realistic monthly sales, then write a Python script that prints the top 3 months and a text bar chart.',
  },
  {
    icon: Server,
    label: 'Scaffold an API',
    prompt:
      'Scaffold a minimal Node.js Express API in ./todo-api with a health route, in-memory todos CRUD, and a test script. Run the tests.',
  },
  {
    icon: Compass,
    label: 'Explore the files',
    prompt: 'List the workspace, read anything interesting, and tell me what this project is and what I should do next.',
  },
]

export function EmptyState({ onPick, children }: { onPick: (prompt: string) => void; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <h1>What can I help with?</h1>

      {children}

      <div className="suggestions">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.label}
            type="button"
            className="suggestion"
            title={suggestion.prompt}
            onClick={() => onPick(suggestion.prompt)}
          >
            <span className="suggestion-icon">
              <suggestion.icon size={14} />
            </span>
            {suggestion.label}
          </button>
        ))}
      </div>
    </div>
  )
}
