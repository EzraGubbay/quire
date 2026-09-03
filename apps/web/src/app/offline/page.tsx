export const dynamic = 'force-static';

export default function OfflinePage() {
  return (
    <main
      style={{ display: 'grid', placeItems: 'center', minHeight: '70vh', padding: 24, textAlign: 'center' }}
    >
      <div>
        <h1 style={{ font: '600 24px/1.2 var(--eg-font-heading)', margin: '0 0 8px' }}>You are offline</h1>
        <p style={{ color: 'var(--eg-text-2)', margin: 0 }}>
          Quire needs a connection to load your project. Pages you opened recently may still be available from
          the back button.
        </p>
      </div>
    </main>
  );
}
