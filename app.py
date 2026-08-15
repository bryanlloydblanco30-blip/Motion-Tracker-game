"""
app.py  -  Astral Cartographer  |  Flask backend
=================================================
Responsibilities
  * Serve the single-page frontend (templates/index.html)
  * Provide REST API endpoints consumed by the JS frontend
      GET  /api/guides   -> zodiac constellation guide data
      POST /api/save     -> persist a constellation chart to disk
      GET  /api/charts   -> list all saved charts

Run:
    pip install flask
    python app.py
"""

import json
import math
import os
from datetime import datetime

from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Data layer – Campaign Levels (Zodiac Signs in sequential progression)
# ---------------------------------------------------------------------------
LEVELS = [
    {"level": 1,  "name": "Aries",       "symbol": "♈", "pts": [[0.30, 0.55], [0.38, 0.42], [0.47, 0.38], [0.58, 0.44], [0.66, 0.40]]},
    {"level": 2,  "name": "Taurus",      "symbol": "♉", "pts": [[0.28, 0.30], [0.35, 0.42], [0.44, 0.50], [0.40, 0.60], [0.50, 0.62], [0.58, 0.55], [0.62, 0.42]]},
    {"level": 3,  "name": "Gemini",      "symbol": "♊", "pts": [[0.30, 0.30], [0.32, 0.55], [0.34, 0.72], [0.66, 0.28], [0.64, 0.53], [0.62, 0.70]]},
    {"level": 4,  "name": "Cancer",      "symbol": "♋", "pts": [[0.35, 0.35], [0.45, 0.48], [0.42, 0.62], [0.55, 0.50], [0.65, 0.38]]},
    {"level": 5,  "name": "Leo",         "symbol": "♌", "pts": [[0.24, 0.62], [0.34, 0.50], [0.34, 0.34], [0.44, 0.28], [0.54, 0.34], [0.50, 0.46], [0.62, 0.50], [0.70, 0.66]]},
    {"level": 6,  "name": "Virgo",       "symbol": "♍", "pts": [[0.24, 0.34], [0.32, 0.46], [0.30, 0.60], [0.42, 0.68], [0.52, 0.60], [0.60, 0.66], [0.70, 0.50], [0.62, 0.38]]},
    {"level": 7,  "name": "Libra",       "symbol": "♎", "pts": [[0.28, 0.50], [0.44, 0.34], [0.60, 0.50], [0.44, 0.34], [0.44, 0.66]]},
    {"level": 8,  "name": "Scorpius",    "symbol": "♏", "pts": [[0.22, 0.32], [0.30, 0.42], [0.36, 0.52], [0.44, 0.58], [0.52, 0.62], [0.60, 0.66], [0.66, 0.60], [0.72, 0.68]]},
    {"level": 9,  "name": "Sagittarius", "symbol": "♐", "pts": [[0.24, 0.60], [0.36, 0.52], [0.34, 0.36], [0.46, 0.46], [0.58, 0.30], [0.50, 0.50], [0.62, 0.58], [0.44, 0.60]]},
    {"level": 10, "name": "Capricornus", "symbol": "♑", "pts": [[0.22, 0.36], [0.34, 0.48], [0.30, 0.62], [0.44, 0.66], [0.58, 0.58], [0.68, 0.62], [0.60, 0.44]]},
    {"level": 11, "name": "Aquarius",    "symbol": "♒", "pts": [[0.22, 0.40], [0.32, 0.34], [0.40, 0.44], [0.50, 0.36], [0.58, 0.46], [0.68, 0.38], [0.62, 0.58]]},
    {"level": 12, "name": "Pisces",      "symbol": "♓", "pts": [[0.20, 0.30], [0.28, 0.44], [0.26, 0.58], [0.36, 0.68], [0.50, 0.50], [0.64, 0.60], [0.74, 0.52], [0.72, 0.38]]},
]

SAVED_CHARTS_DIR = os.path.join(os.path.dirname(__file__), "saved_charts")
os.makedirs(SAVED_CHARTS_DIR, exist_ok=True)


LEADERBOARD_FILE = os.path.join(os.path.dirname(__file__), "leaderboard.json")

def load_leaderboard():
    if not os.path.exists(LEADERBOARD_FILE):
        return []
    try:
        with open(LEADERBOARD_FILE, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError):
        return []

def save_leaderboard(scores):
    with open(LEADERBOARD_FILE, "w", encoding="utf-8") as fh:
        json.dump(scores, fh, indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Constellation Shape Evaluation & Comparison Engine
# ---------------------------------------------------------------------------

def evaluate_constellation_shape(traced_points, guide_pts, width=1000, height=1000, match_radius=75):
    """
    Compares player traced points against correct target constellation guide points.
    Returns detailed accuracy metrics including star position score, shape/path angle
    and segment length similarity, overall percentage, matched count, and grade.
    """
    if not guide_pts or not traced_points:
        return {
            "pct": 0,
            "grade": "D",
            "matched": 0,
            "total": len(guide_pts) if guide_pts else 0,
            "position_score": 0,
            "shape_score": 0
        }

    # Normalize traced points to 0..1 scale if given as pixel values
    norm_traced = []
    for p in traced_points:
        if isinstance(p, dict):
            px, py = p.get("x", 0), p.get("y", 0)
        else:
            px, py = p[0], p[1]
        
        if px > 1.5 or py > 1.5:
            norm_traced.append([px / width, py / height])
        else:
            norm_traced.append([px, py])

    # Scaled pixel match radius in 0..1 coordinate space
    norm_radius = match_radius / max(width, height)

    # 1. Star Positional Accuracy (Nearest / Sequential distance)
    matched_count = 0
    pos_score_sum = 0.0

    for idx, (gx, gy) in enumerate(guide_pts):
        if idx < len(norm_traced):
            px, py = norm_traced[idx]
            dist = math.hypot(px - gx, py - gy)
            if dist <= norm_radius:
                matched_count += 1
                effective_dist = max(0, dist - (10 / max(width, height)))
                proximity = max(0.0, 1.0 - (effective_dist / max(1e-5, norm_radius)))
                pos_score_sum += proximity
            else:
                # Fallback: check nearest point if not strictly at index
                min_d = min((math.hypot(tp[0] - gx, tp[1] - gy) for tp in norm_traced), default=999)
                if min_d <= norm_radius:
                    matched_count += 1
                    pos_score_sum += max(0.0, 1.0 - (min_d / norm_radius)) * 0.7

    position_score = (pos_score_sum / len(guide_pts)) * 100.0

    # 2. Shape / Path Similarity (Segment Direction Vectors & Relative Length Ratios)
    shape_score_sum = 0.0
    segment_count = max(1, len(guide_pts) - 1)

    if len(guide_pts) > 1 and len(norm_traced) > 1:
        for i in range(min(len(guide_pts) - 1, len(norm_traced) - 1)):
            # Target segment vector
            g_dx = (guide_pts[i+1][0] - guide_pts[i][0]) * width
            g_dy = (guide_pts[i+1][1] - guide_pts[i][1]) * height
            g_len = math.hypot(g_dx, g_dy)

            # Traced segment vector
            p_dx = (norm_traced[i+1][0] - norm_traced[i][0]) * width
            p_dy = (norm_traced[i+1][1] - norm_traced[i][1]) * height
            p_len = math.hypot(p_dx, p_dy)

            if g_len > 1e-4 and p_len > 1e-4:
                # Cosine similarity for directional alignment
                dot = (g_dx * p_dx + g_dy * p_dy)
                cos_sim = max(0.0, dot / (g_len * p_len))

                # Length ratio similarity
                len_ratio = min(g_len, p_len) / max(g_len, p_len)

                segment_sim = (cos_sim * 0.7) + (len_ratio * 0.3)
                shape_score_sum += segment_sim * 100.0
            elif g_len <= 1e-4 and p_len <= 1e-4:
                shape_score_sum += 100.0
        
        shape_score = shape_score_sum / segment_count
    else:
        shape_score = position_score

    # 3. Penalties & Final Combined Percentage
    raw_combined = (position_score * 0.55) + (shape_score * 0.45)
    extra_points = max(0, len(norm_traced) - len(guide_pts))
    penalty = extra_points * 15.0

    pct = int(max(0, min(100, round(raw_combined - penalty))))
    grade = 'S' if pct >= 88 else ('A' if pct >= 72 else ('B' if pct >= 52 else ('C' if pct >= 32 else 'D')))

    return {
        "pct": pct,
        "grade": grade,
        "matched": matched_count,
        "total": len(guide_pts),
        "position_score": round(position_score, 1),
        "shape_score": round(shape_score, 1)
    }


# ---------------------------------------------------------------------------
# Page route
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    """Serve the main Astral Cartographer single-page app."""
    return render_template("index.html")


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------

@app.route("/api/guides")
def get_guides():
    """Return campaign levels."""
    return jsonify(LEVELS)


@app.route("/api/evaluate", methods=["POST"])
def evaluate_shape():
    """
    Evaluate player traced points against a specific level's guide shape.
    JSON body: { level: int, points: list, width: int (optional), height: int (optional) }
    """
    data = request.get_json(silent=True) or {}
    level_id = int(data.get("level", 1))
    traced_pts = data.get("points", [])
    width = int(data.get("width", 1000))
    height = int(data.get("height", 1000))

    level_obj = next((l for l in LEVELS if l["level"] == level_id), None)
    if not level_obj:
        return jsonify({"error": f"Level {level_id} not found"}), 404

    guide_pts = level_obj["pts"]
    result = evaluate_constellation_shape(traced_pts, guide_pts, width=width, height=height)
    return jsonify(result)



@app.route("/api/leaderboard", methods=["GET"])
def get_leaderboard():
    """
    Return leaderboard entries sorted by total_score (cumulative accuracy across levels)
    and max level reached.
    """
    scores = load_leaderboard()

    # Aggregate by player name to show total campaign score
    players = {}
    for entry in scores:
        pname = entry.get("player", "Stargazer")
        if pname not in players:
            players[pname] = {
                "player": pname,
                "total_score": 0,
                "max_level": 1,
                "levels_cleared": 0,
                "level_scores": {}
            }
        
        lvl = entry.get("level", 1)
        score = entry.get("pct", 0)
        
        # Keep highest score per level for this player
        if lvl not in players[pname]["level_scores"] or score > players[pname]["level_scores"][lvl]:
            players[pname]["level_scores"][lvl] = score

    # Calculate total score and progress
    leaderboard_list = []
    for pname, pdata in players.items():
        total_score = sum(pdata["level_scores"].values())
        max_lvl = max(pdata["level_scores"].keys()) if pdata["level_scores"] else 1
        cleared = len(pdata["level_scores"])
        leaderboard_list.append({
            "player": pname,
            "total_score": total_score,
            "max_level": max_lvl,
            "levels_cleared": cleared
        })

    # Sort by total cumulative score descending
    leaderboard_list.sort(key=lambda s: (s["total_score"], s["max_level"]), reverse=True)
    return jsonify(leaderboard_list[:20])


@app.route("/api/leaderboard", methods=["POST"])
def post_leaderboard():
    """
    Save a level completion score.
    JSON body: { player: string, level: int, guide_name: string, pct: int, grade: string }
    """
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "No JSON body"}), 400

    player = str(data.get("player", "Stargazer")).strip() or "Stargazer"
    level = int(data.get("level", 1))
    guide_name = data.get("guide_name", "Aries")
    pct = int(data.get("pct", 0))
    grade = str(data.get("grade", "D"))

    scores = load_leaderboard()
    entry = {
        "player": player[:16],
        "level": level,
        "guide": guide_name,
        "pct": pct,
        "grade": grade,
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M"),
    }
    scores.append(entry)
    save_leaderboard(scores)

    return jsonify({"success": True, "entry": entry})


@app.route("/api/save", methods=["POST"])
def save_chart():
    """
    Persist a constellation chart to the saved_charts/ directory.
    """
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "No JSON body received"}), 400

    points = data.get("points", [])
    guide = data.get("guide")
    player = data.get("player", "Stargazer")

    if not isinstance(points, list):
        return jsonify({"error": "'points' must be a list"}), 400

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = "chart_" + timestamp + ".json"
    filepath = os.path.join(SAVED_CHARTS_DIR, filename)

    chart_payload = {
        "timestamp": timestamp,
        "player": player,
        "guide": guide,
        "star_count": len(points),
        "points": points,
    }

    with open(filepath, "w", encoding="utf-8") as fh:
        json.dump(chart_payload, fh, indent=2, ensure_ascii=False)

    return jsonify({"success": True, "filename": filename, "star_count": len(points)})


@app.route("/api/charts")
def list_charts():
    """
    List metadata for all previously saved constellation charts.

    Response JSON:
        [
          { "filename": "chart_.json", "timestamp": "...", "star_count": <int>, "guide": "Aries" | null },
          ...
        ]
    """
    charts = []
    for fname in sorted(os.listdir(SAVED_CHARTS_DIR), reverse=True):
        if not fname.endswith(".json"):
            continue
        fpath = os.path.join(SAVED_CHARTS_DIR, fname)
        try:
            with open(fpath, encoding="utf-8") as fh:
                payload = json.load(fh)
            charts.append({
                "filename": fname,
                "timestamp": payload.get("timestamp", ""),
                "star_count": payload.get("star_count", 0),
                "guide": payload.get("guide"),
            })
        except (json.JSONDecodeError, OSError):
            continue

    return jsonify(charts)


# ---------------------------------------------------------------------------
# Entry-point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    app.run(debug=True, port=5000)
