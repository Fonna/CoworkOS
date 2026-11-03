# SPDX-License-Identifier: MIT
"""One bounded JSON request, one JSON response; no installation or ambient tool discovery."""

from contextlib import redirect_stdout
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
MAX_REQUEST_BYTES = 1048576


def _reject_constant(_value):
    raise ValueError("Non-finite JSON numbers are not supported")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON keys are not supported")
        result[key] = value
    return result


def _error(code, message):
    return {"ok": False, "error": {"code": code, "message": message}}


def _load(name, filename):
    # Both names and sibling paths are fixed product code.
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _execute(request):
    if not isinstance(request, dict) or set(request) != {"version", "tool", "arguments"}:
        return _error("invalid_request", "Expected only version, tool and arguments")
    version = request["version"]
    if version not in ("sciagentgym-e9dbbea-pilot-v1", "sciagentgym-e9dbbea-analysis-v2", "sciagentgym-e9dbbea-astronomy-v3", "atria-rdkit-chemistry-v4", "sciagentgym-e9dbbea-materials-v5", "sciagentgym-e9dbbea-mass-spec-v6", "atria-statistics-v7"):
        return _error("version_mismatch", "The requested scientific catalog version is unavailable")
    name = request["tool"]
    if version == "atria-statistics-v7" and name in ("summarize_numeric_data", "pearson_correlation", "welch_t_test"):
        module = _load("atria_science_statistics", "statistics.py")
        try:
            return module.run(request)
        except module.ScienceError as error:
            return _error(error.code, str(error))
    pilot = _load("atria_science_pilot", "pilot.py")
    module = pilot
    if version != pilot.VERSION and not (isinstance(name, str) and name in pilot.TOOLS):
        module = _load("atria_science_analysis", "analysis.py")
        if version != module.VERSION and not (isinstance(name, str) and name in module.TOOLS):
            module = _load("atria_science_astronomy", "astronomy.py")
            if version != module.VERSION and not (isinstance(name, str) and name in module.TOOLS):
                module = _load("atria_science_chemistry", "chemistry.py")
                if version != module.VERSION and not (isinstance(name, str) and name in module.TOOLS):
                    module = _load("atria_science_materials", "materials.py")
                    if version != module.VERSION and not (isinstance(name, str) and name in module.TOOLS):
                        if name == "rdkit_exact_mass_and_formula":
                            module = _load("atria_science_mass_chemistry", "mass-chemistry.py")
                        else:
                            module = _load("atria_science_mass_spectrometry", "mass_spectrometry.py")
    # Catalog additions retain the exact implementation of every earlier function.
    request = {**request, "version": module.VERSION}
    try:
        return module.run(request)
    except module.ScienceError as error:
        return _error(error.code, str(error))


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            response = _error("invalid_request", "Scientific request exceeds 1 MiB")
        else:
            try:
                request = json.loads(raw.decode("utf-8"), parse_constant=_reject_constant, object_pairs_hook=_unique_object)
            except (ValueError, UnicodeError, RecursionError):
                request = None
            if request is None:
                response = _error("invalid_request", "Expected one valid UTF-8 JSON request")
            else:
                with redirect_stdout(sys.stderr):
                    response = _execute(request)
        output = json.dumps(response, allow_nan=False, separators=(",", ":"))
    except Exception:
        output = json.dumps(_error("internal_error", "Scientific execution failed; check the configured Python environment"), separators=(",", ":"))
    sys.stdout.write(output + "\n")


if __name__ == "__main__":
    main()
