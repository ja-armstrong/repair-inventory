/**
 * Placeholder page shell. Each area's page file exists now so the app shell
 * navigates; later tickets replace the placeholder content in the page file,
 * keeping the route and the nav untouched.
 */
export function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return (
    <section>
      <h2>{title}</h2>
      <p className="placeholder">{description}</p>
    </section>
  );
}
