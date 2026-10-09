import type { Item } from '../lib/schema';

const KIND_LABEL: Record<Item['kind'], string> = { link: 'Link', text: 'Text', image: 'Image' };

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

export default function ItemCard({ item, collectionName, onOpen }: { item: Item; collectionName: string; onOpen: () => void }) {
  const preview = item.kind === 'link' ? hostOf(item.content) : item.kind === 'text' ? item.content : '';
  return (
    <button className="card item" onClick={onOpen}>
      {item.kind === 'image' && <img className="thumb" src={item.content} alt="" loading="lazy" />}
      <div className="item-body">
        <div className="item-subject">{item.subject || '(no subject)'}</div>
        {preview && preview !== item.subject && <div className="item-preview">{preview}</div>}
        <div className="item-meta">
          <span className={`kind kind-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
          <span>{collectionName}</span>
          <span>{new Date(item.created_at).toLocaleDateString()}</span>
          {item.tags.slice(0, 3).map((t) => <span key={t} className="tag">#{t}</span>)}
        </div>
      </div>
    </button>
  );
}
