import type { Channel } from '../../types'

interface ChannelListProps {
  channels: Channel[]
  selected: string | null
  onSelect: (id: string) => void
}

export function ChannelList({ channels, selected, onSelect }: ChannelListProps) {
  // Don't render anything if no channels
  if (channels.length === 0) return null

  return (
    <nav className="channel-list">
      <h3>Channels</h3>
      <ul>
        {channels.map((channel) => (
          <li key={channel.id}>
            <button
              className={`channel-item ${selected === channel.id ? 'selected' : ''}`}
              onClick={() => onSelect(channel.id)}
            >
              <span className="channel-name">#{channel.name}</span>
              {channel.metadata?.tagline && (
                <span className="channel-tagline">{channel.metadata.tagline}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
