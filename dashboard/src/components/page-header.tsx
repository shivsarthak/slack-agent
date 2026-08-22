export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="space-y-1.5">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description && (
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>
      )}
    </div>
  );
}
