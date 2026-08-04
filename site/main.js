/* =========================================================================
   Contexto landing: the live density self-demo (reference implementation).
   No frameworks, no network. Plain ES5-friendly JS.

   Three things can move the dial, in this order of authority:
     1. the reader, once they touch the slider (they keep it for good)
     2. page scroll, while the pinned card is on screen
     3. the opening drift, a short teaser that runs when the card first appears
   3 hands off to 2 by anchoring the scrub on the level the drift had reached,
   so the paragraph never jumps or snaps backwards at the changeover.
   ========================================================================= */

(function () {
  var root = document.getElementById("ctx-live");
  if (!root) return;

  var stage = document.getElementById("ctx-stage"),
    pin = document.getElementById("ctx-pin"),
    scrubber = document.getElementById("ctx-scrub"),
    header = document.querySelector(".site-header"),
    cue = document.getElementById("ctx-cue"),
    cueText = document.getElementById("ctx-cue-text");

  var range = root.querySelector("#ctx-range"),
    read = root.querySelector("#ctx-read"),
    tip = root.querySelector("#ctx-tip");
  var words = [].slice.call(root.querySelectorAll(".w"));
  var reduce =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Where the opening drift settles if nobody scrolls. */
  var FLOOR = 0.22;

  function apply(d) {
    var on = 0;
    words.forEach(function (w) {
      var th = parseFloat(w.getAttribute("data-th"));
      if (d >= th) {
        if (!w.classList.contains("on")) {
          w.classList.add("on");
          w.textContent = w.getAttribute("data-es");
          w.setAttribute("lang", "es");
        }
        on++;
      } else {
        if (w.classList.contains("on")) {
          w.classList.remove("on");
          w.textContent = w.getAttribute("data-en");
          w.removeAttribute("lang");
        }
      }
    });
    var pct = Math.round(d * 100);
    var count = on + (on === 1 ? " word" : " words");
    // At the top of the dial the percentage stops earning its place (and reads
    // like a claim the extension replaces whole pages), so show only the count.
    read.textContent = pct === 100 ? count : pct + "% · " + count;
    // Track fill, per the reference. Set as background-image (not the background
    // shorthand) so the stylesheet's background-clip survives on mobile, where the
    // track is padded to a 44px touch target but should still read as a thin line.
    range.style.backgroundImage =
      "linear-gradient(to right,#2f5d80 " + pct + "%,#dce3ea " + pct + "%)";
    range.value = pct;
    // Keep the screen-reader value text describing how much Spanish is shown.
    range.setAttribute(
      "aria-valuetext",
      pct === 100
        ? "Every eligible word in Spanish, " + count + " shown"
        : pct + " percent Spanish, " + count + " shown"
    );
  }

  var userControl = false,
    rafId = null,
    start = null,
    driftValue = 0,
    driftStarted = false,
    scrubBase = 0,
    scrubEngaged = false,
    scrollDriven = false,
    stickyTop = 0,
    stagePadTop = 0,
    scrub = 0,
    ticking = false,
    settled = false;

  function ease(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  /* ---- the cue, and the idle halo on the thumb ---- */

  // Both exist only to say "this thing moves". The moment it demonstrably does,
  // they have made their point and get out of the way.
  function settle() {
    if (settled) return;
    settled = true;
    if (cue) cue.classList.add("is-hidden");
    range.classList.remove("is-idle");
  }

  /* ---- the pinned scroll scrub ---- */

  // Pinning a card taller than the window would cut off its own last line (and
  // the paragraph's ending is the punchline), so short windows and reduced
  // motion keep the plain unpinned demo and the drag-me cue.
  function measure() {
    if (!stage || !pin || !scrubber) return;
    // A page opened into a background tab lays out at zero height, and deciding
    // "the card does not fit" off that would kill the pin for the whole visit.
    // Leave the verdict to the next measure instead.
    if (!window.innerHeight) return;
    var minTop = (header ? header.offsetHeight : 0) + 10;
    var pinH = pin.offsetHeight;
    var fits = pinH + minTop <= window.innerHeight - 10;

    scrollDriven = !reduce && fits;
    stage.classList.toggle("is-scrubbing", scrollDriven);

    if (!scrollDriven) {
      scrub = 0;
      stage.style.removeProperty("--dial-top");
      // A window shrunk mid-scrub disarms the pin, and progress collapses to 0.
      // The page cannot drive the dial any more, so the reader owns it from
      // here: freezing it where it stands beats snapping back to the drift, and
      // it keeps the scrub from re-arming at a compressed range later.
      if (scrubEngaged) userControl = true;
      if (cueText) cueText.textContent = "Drag the dial toward Spanish";
      return;
    }

    // Centre the card when there is room, but never under the sticky header.
    stickyTop = Math.max(minTop, Math.floor((window.innerHeight - pinH) / 2));
    stage.style.setProperty("--dial-top", stickyTop + "px");
    // Read both back rather than assuming the clamp()s: the scrub length and the
    // stage's own top padding are what the progress sum is built from.
    stagePadTop = parseFloat(getComputedStyle(stage).paddingTop) || 0;
    scrub = scrubber.offsetHeight;
    // Never promise scrolling to someone who now holds the dial by hand.
    if (cueText && !userControl) {
      cueText.textContent = "Keep scrolling to raise the dial";
    }
  }

  // 0 before the card sticks, 1 once it has travelled the whole scrub.
  function progress() {
    if (!scrollDriven || scrub <= 0) return 0;
    // Where the card would sit if it were not stuck.
    var natural = stage.getBoundingClientRect().top + stagePadTop;
    var p = (stickyTop - natural) / scrub;
    return p < 0 ? 0 : p > 1 ? 1 : p;
  }

  function render() {
    if (userControl) return;
    var p = progress();
    // The scrub picks up exactly where the drift had got to and stretches that
    // to the top of the dial, so the handoff cannot jump however early it
    // happens, and the whole scrub length stays useful.
    if (p > 0 && !scrubEngaged) {
      scrubEngaged = true;
      scrubBase = driftValue;
      if (rafId) cancelAnimationFrame(rafId);
    }
    apply(scrubEngaged ? scrubBase + (1 - scrubBase) * p : driftValue);
    // Let the cue stand through the first stretch, so the reader connects their
    // own scrolling to the words turning over, then retire it.
    if (p > 0.15) settle();
  }

  /* ---- the opening drift ---- */

  function drift(ts) {
    if (userControl || scrubEngaged) return;
    if (start === null) start = ts;
    var e = ts - start,
      d;
    if (e < 2400) {
      d = 0.42 * ease(e / 2400);
    } else if (e < 4000) {
      d = 0.42;
    } else if (e < 6000) {
      d = 0.42 - (0.42 - FLOOR) * ease((e - 4000) / 2000);
    } else {
      driftValue = FLOOR;
      render();
      return;
    }
    driftValue = d;
    render();
    // render() may have just handed the dial to the scroll scrub.
    if (scrubEngaged) return;
    rafId = requestAnimationFrame(drift);
  }

  // Held back until the card is actually on screen, so the teaser is not spent
  // above the fold on the phones that load with the demo still below it.
  function startDrift() {
    if (driftStarted || userControl || reduce) return;
    driftStarted = true;
    range.classList.add("is-idle");
    rafId = requestAnimationFrame(drift);
  }

  /* ---- the reader takes over, and keeps it ---- */

  function takeManual() {
    userControl = true;
    if (rafId) cancelAnimationFrame(rafId);
    settle();
  }

  range.addEventListener("input", function () {
    takeManual();
    apply(range.value / 100);
  });
  range.addEventListener("pointerdown", takeManual);
  // Tabbing through the control is not taking hold of it, and handing the dial
  // over for a Tab would cost a keyboard reader the scroll-driven demo. Only
  // the keys that actually move a range count.
  range.addEventListener("keydown", function (ev) {
    if (/^(Arrow|Page|Home|End)/.test(ev.key || "")) takeManual();
  });

  /* ---- tooltip ---- */

  root.addEventListener("mouseover", function (ev) {
    var w = ev.target.closest && ev.target.closest(".w.on");
    if (!w) return;
    var rb = root.getBoundingClientRect(),
      wb = w.getBoundingClientRect();
    tip.textContent = w.getAttribute("data-en") + " to " + w.getAttribute("data-es");
    tip.style.opacity = "1";
    tip.style.left = Math.round(wb.left - rb.left + wb.width / 2) + "px";
    tip.style.top = Math.round(wb.bottom - rb.top + 8) + "px";
    tip.style.transform = "translateX(-50%)";
  });
  root.addEventListener("mouseout", function (ev) {
    if (ev.target.closest && ev.target.closest(".w")) tip.style.opacity = "0";
  });

  /* ---- wiring ---- */

  window.addEventListener(
    "scroll",
    function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        render();
      });
    },
    { passive: true }
  );

  window.addEventListener("resize", function () {
    measure();
    render();
  });

  // First real chance to measure a tab that was opened in the background.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) return;
    measure();
    render();
  });

  // The card's height decides whether it can be pinned at all, so re-measure
  // once everything that affects it has landed.
  window.addEventListener("load", function () {
    measure();
    render();
  });

  measure();

  if (reduce) {
    driftValue = FLOOR;
  } else if (window.IntersectionObserver) {
    var io = new IntersectionObserver(
      function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) {
            io.disconnect();
            startDrift();
            return;
          }
        }
      },
      { threshold: 0.3 }
    );
    io.observe(root);
  } else {
    startDrift();
  }

  render();
})();
