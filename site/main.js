/* =========================================================================
   Contexto landing — two small behaviors:
   1. Act one reveal: stagger-fade the four serif lines in (reduced-motion safe)
   2. Act two dial: the live density self-demo (reference implementation)
   No frameworks, no network. Plain ES5-friendly JS.
   ========================================================================= */

/* ---- Act one: stagger-fade the reveal lines ---- */
(function () {
  var el = document.getElementById("ctx-reveal");
  if (!el) return;
  var reduce =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (reduce) {
    el.classList.add("in"); // CSS shows lines immediately with no transition
    return;
  }

  function show() {
    el.classList.add("in");
  }

  // Reveal when scrolled into view; if already in view on load, reveal now.
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            show();
            io.disconnect();
          }
        });
      },
      { threshold: 0.25 }
    );
    io.observe(el);
  } else {
    show();
  }
})();

/* ---- Act two: the dial-in self-demo (known-good reference behavior) ---- */
(function () {
  var root = document.getElementById("ctx-live");
  if (!root) return;
  var range = root.querySelector("#ctx-range"),
    read = root.querySelector("#ctx-read"),
    tip = root.querySelector("#ctx-tip");
  var words = [].slice.call(root.querySelectorAll(".w"));
  var reduce =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
    read.textContent = pct + "% · " + on + (on === 1 ? " word" : " words");
    // Track fill, per the reference. Set as background-image (not the background
    // shorthand) so the stylesheet's background-clip survives on mobile, where the
    // track is padded to a 44px touch target but should still read as a thin line.
    range.style.backgroundImage =
      "linear-gradient(to right,#2f5d80 " + pct + "%,#dce3ea " + pct + "%)";
    range.value = pct;
    // Keep the screen-reader value text describing how much Spanish is shown.
    range.setAttribute(
      "aria-valuetext",
      pct + " percent Spanish, " + on + (on === 1 ? " word" : " words") + " shown"
    );
  }

  var userControl = false,
    rafId = null,
    start = null;

  function ease(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function drift(ts) {
    if (userControl) return;
    if (start === null) start = ts;
    var e = ts - start,
      d;
    if (e < 2400) {
      d = 0.42 * ease(e / 2400);
    } else if (e < 4000) {
      d = 0.42;
    } else if (e < 6000) {
      d = 0.42 - 0.2 * ease((e - 4000) / 2000);
    } else {
      apply(0.22);
      return;
    }
    apply(d);
    rafId = requestAnimationFrame(drift);
  }

  function stop() {
    userControl = true;
    if (rafId) cancelAnimationFrame(rafId);
  }

  range.addEventListener("input", function () {
    stop();
    apply(range.value / 100);
  });
  range.addEventListener("pointerdown", stop);
  range.addEventListener("keydown", stop);

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

  if (reduce) {
    apply(0.22);
  } else {
    apply(0);
    rafId = requestAnimationFrame(drift);
  }
})();
