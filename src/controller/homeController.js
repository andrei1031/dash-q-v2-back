exports.home = async (_, res) => {
    try {
        res.send("<h4>Dash-Q API is running...</h4>");
    } catch (err) {
        console.error("Api endpoint failed:", err.message);
        return res.status(500).json({ error: 'Server error accessing root api endpoint.' });
    }
};