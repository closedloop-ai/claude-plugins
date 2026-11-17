# Provider text for skills/vibe/references/annotations.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: route-map -->
1. Start from the route in the tab's address bar. Map it to its
   `FEATURE_MAP.md` entry (`pnpm control feature show <id>`), which names the
   route file and the main components.
2. Search for the element's visible text in `packages/app`, `apps/app`,
   `apps/desktop/src/renderer`, and `packages/design-system`. Text that comes
   from a label map or constant leads to the map; follow it to the component
   that renders it.
<!-- end: route-map -->
