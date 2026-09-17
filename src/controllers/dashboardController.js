const Project = require('../models/Project');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const LeaveRequest = require('../models/LeaveRequest');

const getTodayString = (date = new Date()) => {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// @desc    Get roll-up dashboard metrics for executive and team overview
// @route   GET /api/dashboard/stats
exports.getStats = async (req, res) => {
  try {
    const todayStr = getTodayString();
    const currentMonthPrefix = todayStr.substring(0, 7);

    // 1. Projects Statistics
    const allProjects = await Project.find().select('title code department status completionPercentage deadline clientName priority');
    const totalProjects = allProjects.length;
    const activeProjects = allProjects.filter((p) => p.status === 'in_progress').length;
    const completedProjects = allProjects.filter((p) => p.status === 'completed').length;
    const reviewProjects = allProjects.filter((p) => p.status === 'review').length;
    const planningProjects = allProjects.filter((p) => p.status === 'planning').length;

    // Department-wise project counts & completion averages
    const departments = [
      'Software Development',
      'Digital Marketing (SEO)',
      'Graphics Designing',
      'WordPress Team',
    ];

    const departmentStats = departments.map((dept) => {
      const deptProjects = allProjects.filter((p) => p.department === dept);
      const count = deptProjects.length;
      const avgProgress = count > 0
        ? Math.round(deptProjects.reduce((acc, p) => acc + (p.completionPercentage || 0), 0) / count)
        : 0;
      const activeCount = deptProjects.filter((p) => p.status === 'in_progress').length;

      return {
        department: dept,
        totalProjects: count,
        activeProjects: activeCount,
        avgProgress,
      };
    });

    // 2. Users / Employees
    const totalEmployees = await User.countDocuments({ isActive: true, role: { $ne: 'CEO' } });

    // 3. Today's Attendance
    const todayRecords = await Attendance.find({ date: todayStr }).populate('user', 'name role department');
    const presentCount = todayRecords.filter((r) => r.status === 'present').length;
    const lateCount = todayRecords.filter((r) => r.isLate).length;
    const halfDayCount = todayRecords.filter((r) => r.status === 'half_day').length;
    const checkedInCount = todayRecords.length;
    const absentCount = Math.max(0, totalEmployees - checkedInCount);

    const todayDeductionTotal = todayRecords.reduce((sum, r) => sum + (r.deductionAmount || 0), 0);

    // 4. Monthly Deductions
    const monthRecords = await Attendance.find({
      date: { $regex: `^${currentMonthPrefix}` },
      deductionAmount: { $gt: 0 },
    });
    const monthlyDeductionsTotal = monthRecords.reduce((sum, r) => sum + (r.deductionAmount || 0), 0);

    // 5. Critical Upcoming Deadlines
    const now = new Date();
    const upcomingDeadlines = allProjects
      .filter((p) => p.status !== 'completed' && new Date(p.deadline) >= now)
      .sort((a, b) => new Date(a.deadline) - new Date(b.deadline))
      .slice(0, 5);

    // 6. Pending Leave Approvals
    const pendingLeavesCount = await LeaveRequest.countDocuments({ status: 'pending' });

    res.json({
      success: true,
      projects: {
        total: totalProjects,
        active: activeProjects,
        completed: completedProjects,
        inReview: reviewProjects,
        planning: planningProjects,
        departmentBreakdown: departmentStats,
      },
      attendance: {
        totalEmployees,
        checkedInToday: checkedInCount,
        presentCount,
        lateCount,
        halfDayCount,
        absentCount,
        todayDeductions: todayDeductionTotal,
        monthlyDeductions: monthlyDeductionsTotal,
      },
      upcomingDeadlines,
      pendingLeavesCount,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
