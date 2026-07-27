export function VideoShowcase() {
  return (
    <section className="mx-auto max-w-4xl px-4 py-20">
      <div className="section-divider mb-16" />
      <div className="mb-10 text-center">
        <h2 className="text-3xl font-extrabold sm:text-4xl">
          Watch Forge <span className="gradient-text">build a game</span> from a single prompt
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-zinc-500">
          A complete web-based 2D stickman level editor and game — created entirely by Forge from
          one natural language prompt, including drawing tools, physics, collision detection, and
          scrolling camera.
        </p>
      </div>
      <div className="terminal-glow overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900">
        {/* Video title bar */}
        <div className="flex items-center gap-1.5 border-b border-zinc-800 px-4 py-3">
          <span className="h-3 w-3 rounded-full bg-red-500/80" />
          <span className="h-3 w-3 rounded-full bg-yellow-500/80" />
          <span className="h-3 w-3 rounded-full bg-green-500/80" />
          <span className="ml-3 text-xs text-zinc-500 font-mono">forge demo — stickman game</span>
        </div>
        <div className="p-1">
          <video className="w-full rounded-xl" controls preload="metadata" poster="" playsInline>
            <source src="/forge_demo.mp4" type="video/mp4" />
            Your browser does not support the video tag.
          </video>
        </div>
      </div>
      {/* Demo prompt callout */}
      <div className="mt-6 glass-card rounded-2xl p-5">
        <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-zinc-400">
          The prompt that built this
        </p>
        <p className="font-mono text-sm leading-relaxed text-zinc-300 italic">
          "Create a web-based 2D stickman game with two modes: Map Editor (grid canvas,
          terrain/platform drawing, spikes, enemies, eraser, Play button) and Game Mode (stickman
          with auto-forward movement, jump, collision detection, and scrolling camera)."
        </p>
      </div>
    </section>
  );
}
