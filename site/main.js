/* =========================================================================
   Contexto landing: the live density self-demo (reference implementation).
   No frameworks, no network. Plain ES5-friendly JS.

   Three things can move the dial, in this order of authority:
     1. the reader, once they touch the slider (they keep it for good)
     2. page scroll, while the pinned card is on screen
     3. the reader's first downward scroll, which gently nudges the dial while
        they approach the pinned card
   Nothing moves on page open. 3 hands off to 2 by anchoring the scrub on the
   nudge's current level, so the paragraph never jumps at the changeover. Once
   the reader scrolls fully past the demo, scroll control retires for the visit.
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

  /* Where the gentle approach nudge lands when the card pins. */
  var FLOOR = 0.15;

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
    // Keep the screen-reader value text target-language neutral too.
    range.setAttribute(
      "aria-valuetext",
      pct === 100
        ? "Every eligible target-language word, " + count + " shown"
        : pct + " percent target-language words, " + count + " shown"
    );
  }

  var userControl = false,
    nudgeValue = 0,
    nudgeStarted = false,
    nudgeStartY = window.scrollY,
    scrubBase = 0,
    scrubEngaged = false,
    scrollComplete = false,
    scrollDriven = false,
    stickyTop = 0,
    stagePadTop = 0,
    scrub = 0,
    lastScrollY = window.scrollY,
    ticking = false,
    settled = false;

  /* ---- the cue, and the idle halo on the thumb ---- */

  // Both exist only to say "this thing moves". The moment it demonstrably does,
  // they have made their point and get out of the way.
  function settle() {
    if (settled) return;
    settled = true;
    if (cue) cue.classList.add("is-hidden");
    range.classList.remove("is-idle");
  }

  // The scroll demo gets one pass. Collapse the spacer after completion, then
  // compensate against the following section so the visible page does not jump.
  function completeScrollDemo() {
    if (scrollComplete) return;
    var section = stage.parentElement && stage.parentElement.parentElement;
    var nextSection = section && section.nextElementSibling;
    var anchorTop = nextSection ? nextSection.getBoundingClientRect().top : null;
    var documentElement = document.documentElement;
    var previousOverflowAnchor = documentElement.style.overflowAnchor;

    // Prevent the browser's own scroll anchoring from racing our measured
    // compensation when the 1,040px scrub spacer leaves layout.
    documentElement.style.overflowAnchor = "none";
    scrollComplete = true;
    scrollDriven = false;
    if (!userControl) {
      apply(1);
      userControl = true;
    }
    stage.classList.remove("is-scrubbing");
    stage.classList.add("is-complete");
    if (nextSection && anchorTop !== null) {
      var shiftedTop = nextSection.getBoundingClientRect().top;
      window.scrollBy({
        top: shiftedTop - anchorTop,
        left: 0,
        behavior: "instant",
      });
      lastScrollY = window.scrollY;
    }
    requestAnimationFrame(function () {
      documentElement.style.overflowAnchor = previousOverflowAnchor;
    });
    settle();
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
    if (scrollComplete) {
      scrollDriven = false;
      stage.classList.remove("is-scrubbing");
      stage.classList.add("is-complete");
      return;
    }
    var minTop = (header ? header.offsetHeight : 0) + 10;
    var pinH = pin.offsetHeight;
    var fits = pinH + minTop <= window.innerHeight - 10;

    scrollDriven = !reduce && fits;
    stage.classList.remove("is-complete");
    stage.classList.toggle("is-scrubbing", scrollDriven);

    if (!scrollDriven) {
      scrub = 0;
      stage.style.removeProperty("--dial-top");
      // A window shrunk mid-scrub disarms the pin, and progress collapses to 0.
      // The page cannot drive the dial any more, so the reader owns it from
      // here: freezing it where it stands beats snapping back to the nudge, and
      // it keeps the scrub from re-arming at a compressed range later.
      if (scrubEngaged) userControl = true;
      if (cueText) cueText.textContent = "Drag toward your target language";
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
    // The scrub picks up exactly where the approach nudge got to and stretches
    // that to the top of the dial, so the handoff cannot jump.
    if (p > 0 && !scrubEngaged) {
      scrubEngaged = true;
      scrubBase = nudgeValue;
    }
    apply(scrubEngaged ? scrubBase + (1 - scrubBase) * p : nudgeValue);
    // Let the cue stand through the first stretch, so the reader connects their
    // own scrolling to the words turning over, then retire it.
    if (p > 0.15) settle();
  }

  function retireIfPassed() {
    if (scrollComplete || !scrollDriven) return;
    // At this point sticky has already released and the card is fully behind
    // the header, so retiring it cannot make visible content jump.
    if (pin.getBoundingClientRect().bottom <= stickyTop + 1) {
      completeScrollDemo();
    }
  }

  /* ---- the gentle, scroll-only approach nudge ---- */

  function stageIsNear() {
    var box = stage.getBoundingClientRect();
    return box.bottom > 0 && box.top < window.innerHeight * 0.95;
  }

  // The first downward page scroll starts the nudge, but only when the demo is
  // near enough to see. It never runs from a timer, so a reader who is still
  // reading the headline sees a completely still dial.
  function startNudge(previousY) {
    if (
      nudgeStarted ||
      userControl ||
      scrubEngaged ||
      reduce ||
      !scrollDriven ||
      !stageIsNear()
    )
      return;
    nudgeStarted = true;
    nudgeStartY = previousY;
    range.classList.add("is-idle");
  }

  function updateNudge(scrollY) {
    if (!nudgeStarted || userControl || scrubEngaged) return;
    var stageTop = stage.getBoundingClientRect().top + scrollY + stagePadTop;
    var engageY = stageTop - stickyTop;
    var run = Math.max(1, engageY - nudgeStartY);
    var p = (scrollY - nudgeStartY) / run;
    p = p < 0 ? 0 : p > 1 ? 1 : p;
    nudgeValue = FLOOR * p;
  }

  /* ---- the reader takes over, and keeps it ---- */

  function takeManual() {
    userControl = true;
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
      var previousY = lastScrollY;
      var currentY = window.scrollY;
      if (currentY > previousY) startNudge(previousY);
      lastScrollY = currentY;
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        updateNudge(window.scrollY);
        render();
        retireIfPassed();
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

  render();
})();
